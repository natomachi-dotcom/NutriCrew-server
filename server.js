require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const AI_API_BASE = process.env.AI_API_BASE || "https://nutricrew-backend.vercel.app";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://nutricrew-frontend.vercel.app";
const CRUD_SELF_URL = process.env.CRUD_SELF_URL || "https://nutricrew-server-1.onrender.com";
const FREE_PAIRING_LIMIT = 1;

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:renatogadeabi@gmail.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

app.set('trust proxy', 1);
// contentSecurityPolicy/CORP are tuned off/loosened: this is a JSON API with
// no HTML to protect, and tightening CORP breaks cross-origin fetch() from
// the frontend's different Vercel origin.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors());
app.use(express.json());

// Baseline abuse protection on every API route, per IP.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});
app.use('/api', apiLimiter);

// Stricter limiter on account creation to slow brute-force/spam signups.
const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this IP. Please try again later.' },
});

// Gates admin-only endpoints (user directory, subscriber export, meals CRUD).
// Fails closed if ADMIN_API_KEY isn't configured, so these never end up
// accidentally public in an environment that forgot to set it.
function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) return res.status(503).json({ error: 'Admin API is not configured' });
  if (req.headers['x-admin-key'] !== ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Gates service-to-service endpoints called only by nutricrew-backend.
function requireInternal(req, res, next) {
  if (!INTERNAL_API_KEY) return res.status(503).json({ error: 'Internal API is not configured' });
  if (req.headers['x-internal-key'] !== INTERNAL_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// --- Models ---

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    pairingCount: { type: Number, default: 0 },
    isPremium: { type: Boolean, default: false },
    emailVerified: { type: Boolean, default: false },
    registeredIP: { type: String, default: null },
    otpHash: { type: String, default: null },
    otpExpiry: { type: Date, default: null },
    otpAttempts: { type: Number, default: 0 },
    sessionToken: { type: String, default: null },
    sessionExpiry: { type: Date, default: null },
    seenDayIds: [{ type: mongoose.Schema.Types.ObjectId }],
  },
  { timestamps: true }
);

const User = mongoose.model('User', userSchema);

const cachedDaySchema = new mongoose.Schema({
  dietKey:          { type: String, index: true },
  goalKey:          { type: String, index: true },
  budgetLevel:      String,
  kitchenKey:       String,
  calorieTargetKey: String,
  lang:             String,
  meals:            [mongoose.Schema.Types.Mixed],
  totalCalories:    Number,
  useCount:         { type: Number, default: 0 },
}, { timestamps: true });
cachedDaySchema.index({ dietKey: 1, goalKey: 1, budgetLevel: 1, kitchenKey: 1, calorieTargetKey: 1, lang: 1 });
const CachedDay = mongoose.model('CachedDay', cachedDaySchema);

const cachedExtrasSchema = new mongoose.Schema({
  dietKey:          String,
  goalKey:          String,
  budgetLevel:      String,
  kitchenKey:       String,
  calorieTargetKey: String,
  lang:             String,
  destinationKey:   String,
  goingUsa:         String,
  pairingDays:      Number,
  summary:          String,
  groceryList:      mongoose.Schema.Types.Mixed,
  foodRestrictions: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
cachedExtrasSchema.index(
  { dietKey:1, goalKey:1, budgetLevel:1, kitchenKey:1, calorieTargetKey:1, lang:1, destinationKey:1, goingUsa:1, pairingDays:1 },
  { unique: true }
);
cachedExtrasSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 }); // 7-day TTL
const CachedExtras = mongoose.model('CachedExtras', cachedExtrasSchema);

const scheduledPairingSchema = new mongoose.Schema({
  email:            { type: String, index: true },
  pairingDate:      { type: Date, index: true },
  returnDate:       Date,
  pairingDays:      Number,
  departure:        String,
  destinations:     [String],
  goingUsa:         String,
  timezone:         Number,
  kitchen:          { type: [String], default: ["hotel"] },
  kitchenConfirmed: { type: Boolean, default: false },
  confirmToken:     { type: String, unique: true, sparse: true },
  reminderSentAt:   Date,
  planEmailSentAt:  Date,
  profile: {
    name: String, gender: String, weight: String, dob: String,
    position: String, diets: [String], goals: [String],
    budgetAmount: String, budgetType: String, lang: String, lunchBag: String,
  },
}, { timestamps: true });
const ScheduledPairing = mongoose.model('ScheduledPairing', scheduledPairingSchema);

const mealSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    calories: { type: Number, required: true },
    protein: { type: Number, default: 0 },
    carbs: { type: Number, default: 0 },
    fats: { type: Number, default: 0 },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

const Meal = mongoose.model('Meal', mealSchema);

const gymPlanSchema = new mongoose.Schema({
  email:   { type: String, index: true },
  month:   { type: String, index: true }, // "YYYY-MM"
  plan:    { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });
gymPlanSchema.index({ email: 1, month: 1 }, { unique: true });
const GymPlan = mongoose.model('GymPlan', gymPlanSchema);

const pushSubscriptionSchema = new mongoose.Schema({
  email: { type: String, index: true },
  subscription: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });
const PushSubscription = mongoose.model('PushSubscription', pushSubscriptionSchema);

async function sendPushToEmail(email, payload) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  const subs = await PushSubscription.find({ email }).lean();
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub.subscription, JSON.stringify(payload));
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await PushSubscription.deleteOne({ _id: sub._id });
      }
    }
  }
}

// --- Routes ---

app.get('/', (req, res) => {
  res.send('NutriCrew API is running');
});

// Users
app.post('/api/users', signupLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email and password are required' });
    }
    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashedPassword });
    const { password: _password, ...userData } = user.toObject();
    res.status(201).json(userData);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Email already in use' });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: 'Invalid user id' });
  }
});

app.put('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const { name, email } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { name, email },
      { new: true, runValidators: true }
    ).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Email already in use' });
    }
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(400).json({ error: 'Invalid user id' });
  }
});

// Subscribers (name + email of every crew member who has checked in)
app.get('/api/subscribers', requireAdmin, async (req, res) => {
  try {
    const subscribers = await User.find()
      .select('name email pairingCount isPremium createdAt -_id')
      .sort({ createdAt: -1 });
    res.json(subscribers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Pairing usage (free-tier enforcement for the AI plan generator)
app.post('/api/pairing-usage/check', requireInternal, async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    if (typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const { clientIP } = req.body;

    let user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      const placeholderPassword = await bcrypt.hash(crypto.randomUUID(), 10);
      user = await User.create({ name: name || normalizedEmail, email: normalizedEmail, password: placeholderPassword });
    }

    // IP enforcement: if this IP already has a DIFFERENT user who hit the limit,
    // apply that user's count to the requesting email too.
    if (clientIP && !user.isPremium) {
      const ipOwner = await User.findOne({ registeredIP: clientIP, emailVerified: true });
      if (ipOwner && ipOwner.email !== normalizedEmail && !ipOwner.isPremium && ipOwner.pairingCount >= FREE_PAIRING_LIMIT) {
        return res.json({ allowed: false, pairingCount: ipOwner.pairingCount, isPremium: false, ipBlocked: true });
      }
    }

    const allowed = user.isPremium || user.pairingCount < FREE_PAIRING_LIMIT;
    res.json({ allowed, pairingCount: user.pairingCount, isPremium: user.isPremium });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/set-premium', requireInternal, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'Missing or invalid email' });
    }
    const user = await User.findOneAndUpdate(
      { email: email.toLowerCase().trim() },
      { isPremium: true },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ isPremium: user.isPremium });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Internal auth endpoints called by nutricrew-backend
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OTP requests. Please try again later.' },
});

app.post('/api/auth/store-otp', requireInternal, otpLimiter, async (req, res) => {
  try {
    const { email, otpHash, clientIP } = req.body;
    if (!email || !otpHash) return res.status(400).json({ error: 'email and otpHash are required' });
    const normalizedEmail = email.toLowerCase().trim();

    // Block if another verified account is already registered from this IP.
    if (clientIP) {
      const ipOwner = await User.findOne({ registeredIP: clientIP, emailVerified: true });
      if (ipOwner && ipOwner.email !== normalizedEmail) {
        return res.status(403).json({ error: 'An account is already linked to this device. Please use that email to sign in.' });
      }
    }

    let user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      const ph = await bcrypt.hash(crypto.randomUUID(), 10);
      user = await User.create({ name: normalizedEmail.split('@')[0], email: normalizedEmail, password: ph });
    }

    // Already verified — skip OTP, issue a fresh session immediately.
    if (user.emailVerified) {
      const sessionToken = crypto.randomBytes(32).toString('hex');
      await User.updateOne({ email: normalizedEmail }, { sessionToken, sessionExpiry: null });
      return res.json({ alreadyVerified: true, token: sessionToken, email: user.email, name: user.name, isPremium: user.isPremium, pairingCount: user.pairingCount });
    }

    const expiry = new Date(Date.now() + 10 * 60 * 1000);
    await User.updateOne({ email: normalizedEmail }, { otpHash, otpExpiry: expiry, otpAttempts: 0 });
    res.json({ alreadyVerified: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/check-otp', requireInternal, async (req, res) => {
  try {
    const { email, otpHash, clientIP } = req.body;
    if (!email || !otpHash) return res.status(400).json({ error: 'email and otpHash are required' });
    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user || !user.otpHash || !user.otpExpiry) {
      return res.status(400).json({ error: 'No code found. Please request a new one.' });
    }
    if (user.otpAttempts >= 5) {
      return res.status(429).json({ error: 'Too many attempts. Please request a new code.' });
    }
    if (new Date() > user.otpExpiry) {
      return res.status(400).json({ error: 'Code expired. Please request a new one.' });
    }
    if (user.otpHash !== otpHash) {
      await User.updateOne({ email: normalizedEmail }, { $inc: { otpAttempts: 1 } });
      const attemptsLeft = 4 - user.otpAttempts;
      return res.status(401).json({ error: `Incorrect code. ${attemptsLeft > 0 ? `${attemptsLeft} attempt(s) left.` : 'Please request a new code.'}` });
    }
    // OTP correct — mark verified, lock IP, issue permanent session token.
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const updates = {
      otpHash: null, otpExpiry: null, otpAttempts: 0,
      emailVerified: true,
      sessionToken,
      sessionExpiry: null, // permanent
    };
    if (clientIP && !user.registeredIP) updates.registeredIP = clientIP;
    await User.updateOne({ email: normalizedEmail }, updates);
    res.json({ token: sessionToken, email: user.email, name: user.name, isPremium: user.isPremium, pairingCount: user.pairingCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/check-session', requireInternal, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const user = await User.findOne({ sessionToken: token });
    // Verified users have a permanent session (sessionExpiry: null).
    // Legacy sessions with an expiry date are still honored until they expire.
    if (!user) return res.status(401).json({ error: 'Invalid session. Please log in again.' });
    if (user.sessionExpiry && new Date() > user.sessionExpiry) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    res.json({ email: user.email, name: user.name, isPremium: user.isPremium, pairingCount: user.pairingCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pairing-usage/increment', requireInternal, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    if (typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOneAndUpdate(
      { email: normalizedEmail },
      { $inc: { pairingCount: 1 } },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ pairingCount: user.pairingCount, isPremium: user.isPremium });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Meals (not used by the live app — admin-only CRUD scaffold)
app.post('/api/meals', requireAdmin, async (req, res) => {
  try {
    const { name, calories, protein, carbs, fats, user } = req.body;
    if (!name || calories === undefined) {
      return res.status(400).json({ error: 'name and calories are required' });
    }
    const meal = await Meal.create({ name, calories, protein, carbs, fats, user });
    res.status(201).json(meal);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/meals', requireAdmin, async (req, res) => {
  try {
    const meals = await Meal.find();
    res.json(meals);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/meals/:id', requireAdmin, async (req, res) => {
  try {
    const meal = await Meal.findById(req.params.id);
    if (!meal) return res.status(404).json({ error: 'Meal not found' });
    res.json(meal);
  } catch (err) {
    res.status(400).json({ error: 'Invalid meal id' });
  }
});

app.put('/api/meals/:id', requireAdmin, async (req, res) => {
  try {
    const { name, calories, protein, carbs, fats, user } = req.body;
    const meal = await Meal.findByIdAndUpdate(
      req.params.id,
      { name, calories, protein, carbs, fats, user },
      { new: true, runValidators: true }
    );
    if (!meal) return res.status(404).json({ error: 'Meal not found' });
    res.json(meal);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/meals/:id', requireAdmin, async (req, res) => {
  try {
    const meal = await Meal.findByIdAndDelete(req.params.id);
    if (!meal) return res.status(404).json({ error: 'Meal not found' });
    res.json({ message: 'Meal deleted' });
  } catch (err) {
    res.status(400).json({ error: 'Invalid meal id' });
  }
});

// --- Error handling ---

// ── MEAL CACHE ENDPOINTS (internal) ──────────────────────────────

// Query unseen cached days for a user matching their profile key
app.post('/api/meal-cache/query', requireInternal, async (req, res) => {
  try {
    const { email, dietKey, goalKey, budgetLevel, kitchenKey, calorieTargetKey, lang, count } = req.body;
    const user = await User.findOne({ email }).select('seenDayIds').lean();
    const seenIds = user?.seenDayIds || [];
    const days = await CachedDay.find({
      dietKey, goalKey, budgetLevel, kitchenKey, calorieTargetKey, lang,
      _id: { $nin: seenIds },
    }).limit(count || 7).lean();
    const total = await CachedDay.countDocuments({ dietKey, goalKey, budgetLevel, kitchenKey, calorieTargetKey, lang });
    res.json({ days, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Store newly generated days into cache
app.post('/api/meal-cache/store', requireInternal, async (req, res) => {
  try {
    const { days, dietKey, goalKey, budgetLevel, kitchenKey, calorieTargetKey, lang } = req.body;
    if (!Array.isArray(days) || days.length === 0) return res.json({ stored: 0, ids: [] });
    const docs = await CachedDay.insertMany(
      days.map(d => ({ meals: d.meals, totalCalories: d.totalCalories, dietKey, goalKey, budgetLevel, kitchenKey, calorieTargetKey, lang }))
    );
    res.json({ stored: docs.length, ids: docs.map(d => String(d._id)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark cached day IDs as seen for a user (and increment usage counters)
app.post('/api/meal-cache/mark-seen', requireInternal, async (req, res) => {
  try {
    const { email, dayIds } = req.body;
    if (!email || !Array.isArray(dayIds) || dayIds.length === 0) return res.json({ ok: true });
    await Promise.all([
      User.updateOne({ email }, { $addToSet: { seenDayIds: { $each: dayIds } } }),
      CachedDay.updateMany({ _id: { $in: dayIds } }, { $inc: { useCount: 1 } }),
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── ROSTER ────────────────────────────────────────────────────────────────────

// Store parsed pairings for a user (called from AI backend after roster parse)
app.post('/api/roster/store', requireInternal, async (req, res) => {
  try {
    const { email, pairings, profile } = req.body;
    if (!email || !Array.isArray(pairings) || pairings.length === 0) {
      return res.status(400).json({ error: 'Missing email or pairings' });
    }
    // Upsert each pairing by email + pairingDate, generate fresh confirm token
    const ops = pairings.map(p => ({
      updateOne: {
        filter: { email, pairingDate: new Date(p.pairingDate) },
        update: {
          $set: {
            email,
            pairingDate: new Date(p.pairingDate),
            returnDate: p.returnDate ? new Date(p.returnDate) : null,
            pairingDays: p.pairingDays,
            departure: p.departure,
            destinations: p.destinations,
            goingUsa: p.goingUsa || 'no',
            timezone: p.timezone || 0,
            kitchenConfirmed: false,
            reminderSentAt: null,
            planEmailSentAt: null,
            profile,
            confirmToken: crypto.randomBytes(24).toString('hex'),
          },
        },
        upsert: true,
      },
    }));
    await ScheduledPairing.bulkWrite(ops);
    res.json({ ok: true, stored: pairings.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Daily cron endpoint — find pairings departing within the next 30h, send reminder emails via AI backend
app.post('/api/roster/send-reminders', requireInternal, async (req, res) => {
  try {
    // Window is relative elapsed time, not a server-local calendar day —
    // calendar-day math (setHours/setDate) depends on the process's TZ and
    // can miss pairings whose UTC date differs from the server's "tomorrow".
    const now = new Date();
    const windowEnd = new Date(now.getTime() + 30 * 60 * 60 * 1000); // next 30h

    const pairings = await ScheduledPairing.find({
      pairingDate: { $gte: now, $lte: windowEnd },
      reminderSentAt: null,
    }).lean();

    let sent = 0;
    for (const p of pairings) {
      try {
        const r = await fetch(`${AI_API_BASE}/api/roster/send-reminder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_API_KEY },
          body: JSON.stringify({
            email: p.email,
            name: p.profile?.name || p.email,
            pairingDate: p.pairingDate,
            destinations: p.destinations,
            departure: p.departure,
            pairingDays: p.pairingDays,
            confirmToken: p.confirmToken,
            lang: p.profile?.lang || 'en',
          }),
        });
        if (r.ok) {
          await ScheduledPairing.updateOne({ _id: p._id }, { $set: { reminderSentAt: new Date() } });
          sent++;
          // Fire push notification alongside the email
          const pushDest = (p.destinations || []).join(' → ') || 'your destination';
          sendPushToEmail(p.email, {
            title: `✈️ ${pushDest} is tomorrow`,
            body: "What's your kitchen? Tap to confirm — your meal plan is ready in 30 seconds.",
            data: {
              url: `${CRUD_SELF_URL}/api/roster/kitchen-select?token=${p.confirmToken}`,
              kitchenUrls: {
                hotel: `${CRUD_SELF_URL}/api/roster/confirm-kitchen?token=${p.confirmToken}&kitchen=hotel`,
                airplane: `${CRUD_SELF_URL}/api/roster/confirm-kitchen?token=${p.confirmToken}&kitchen=airplane_food`,
              },
            },
            actions: [
              { action: 'hotel', title: '🏨 Hotel' },
              { action: 'airplane', title: '✈️ Crew Meals' },
            ],
          }).catch(e => console.error('Push failed for', p.email, e.message));
        }
      } catch (e) { console.error('Reminder send failed for', p.email, e.message); }
    }
    res.json({ ok: true, sent, total: pairings.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public — kitchen confirmation link clicked in email
app.get('/api/roster/confirm-kitchen', async (req, res) => {
  const { token } = req.query;
  const validKitchens = ['hotel', 'microwave', 'fridge', 'airplane_food'];
  const requested = Array.isArray(req.query.kitchen) ? req.query.kitchen : [req.query.kitchen];
  const kitchens = [...new Set(requested.filter(k => validKitchens.includes(k)))];
  if (!token) return res.status(400).send('<h2>Invalid confirmation link.</h2>');
  if (kitchens.length === 0) return res.status(400).send('<h2>Please select at least one kitchen option.</h2>');
  try {
    const pairing = await ScheduledPairing.findOneAndUpdate(
      { confirmToken: token },
      { $set: { kitchen: kitchens, kitchenConfirmed: true } },
      { new: true }
    );
    if (!pairing) return res.status(404).send('<h2>Link expired or not found.</h2>');

    // Trigger plan generation via AI backend (fire-and-forget)
    const payload = {
      data: {
        email: pairing.email,
        name: pairing.profile?.name || '',
        gender: pairing.profile?.gender || '',
        weight: pairing.profile?.weight || '',
        dob: pairing.profile?.dob || '',
        position: pairing.profile?.position || 'cabin',
        pairing_days: String(pairing.pairingDays || 1),
        departure: pairing.departure,
        destinations: pairing.destinations,
        going_usa: pairing.goingUsa || 'no',
        timezone: String(pairing.timezone || 0),
        kitchen: kitchens,
        diets: pairing.profile?.diets || ['none'],
        goals: pairing.profile?.goals || ['energy'],
        budget_amount: pairing.profile?.budgetAmount || '30',
        budget_type: pairing.profile?.budgetType || 'day',
        lang: pairing.profile?.lang || 'en',
        lunch_bag: pairing.profile?.lunchBag || null,
      },
      lang: pairing.profile?.lang || 'en',
    };

    fetch(`${AI_API_BASE}/api/generate-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    })
      .then(async r => {
        if (r.ok) {
          await ScheduledPairing.updateOne({ _id: pairing._id }, { $set: { planEmailSentAt: new Date() } });
        }
      })
      .catch(e => console.error('Plan generation failed for', pairing.email, e.message));

    const kitchenLabels = { hotel: '🏨 Hotel', microwave: '📦 Microwave', fridge: '❄️ Fridge', airplane_food: '✈️ Crew Meals' };
    const badgesHtml = kitchens.map(k => `<span class="badge">${kitchenLabels[k]}</span>`).join(' ');
    const dest = pairing.destinations?.join(' → ') || 'your destination';
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NutriCrew</title><style>body{font-family:system-ui,sans-serif;background:#07101E;color:#F8FAFF;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px;box-sizing:border-box}.card{background:#0F2040;border-radius:20px;padding:40px 32px;max-width:400px;width:100%}.emoji{font-size:56px;margin-bottom:16px}.title{font-size:22px;font-weight:700;color:#C9A84C;margin-bottom:12px}.msg{color:#7A8EAA;font-size:15px;line-height:1.6}.badge{display:inline-block;background:#1E3A6E;color:#E8C96A;padding:6px 16px;border-radius:20px;font-size:14px;font-weight:600;margin:4px}.link{color:#4A9ECC;text-decoration:none;font-size:14px;margin-top:16px;display:block}</style></head><body><div class="card"><div class="emoji">✅</div><div class="title">Kitchen Confirmed!</div><div style="margin:16px 0;">${badgesHtml}</div><div class="msg">Your meal plan for <strong>${dest}</strong> is being prepared.<br><br>📧 Check your email in about 30 seconds — your personalised NutriCrew plan is on its way!</div><a class="link" href="${FRONTEND_URL}">Open NutriCrew App</a></div></body></html>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('<h2>Something went wrong. Please try again.</h2>');
  }
});

// ── GYM PLAN ──────────────────────────────────────────────────────────────────

app.post('/api/gym-plan/store', requireInternal, async (req, res) => {
  const { email, month, plan } = req.body;
  if (!email || !month || !plan) return res.status(400).json({ error: 'Missing fields' });
  try {
    await GymPlan.findOneAndUpdate({ email, month }, { email, month, plan }, { upsert: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('gym-plan store error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/gym-plan/get', requireInternal, async (req, res) => {
  const { email, month } = req.query;
  if (!email || !month) return res.status(400).json({ error: 'Missing fields' });
  try {
    const doc = await GymPlan.findOne({ email, month }).lean();
    res.json({ found: !!doc, plan: doc?.plan || null });
  } catch (err) {
    console.error('gym-plan get error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUSH NOTIFICATIONS ────────────────────────────────────────────────────────

app.post('/api/push/subscribe', requireInternal, async (req, res) => {
  const { email, subscription } = req.body;
  if (!email || !subscription) return res.status(400).json({ error: 'Missing fields' });
  try {
    await PushSubscription.findOneAndUpdate({ email }, { email, subscription }, { upsert: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('push/subscribe error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public kitchen-select page — same design as reminder email, opened when user taps push notification
app.get('/api/roster/kitchen-select', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('<h2>Invalid link.</h2>');
  let dest = 'your pairing';
  try {
    const pairing = await ScheduledPairing.findOne({ confirmToken: token }).lean();
    if (!pairing) return res.status(404).send('<h2>Link expired or not found.</h2>');
    dest = pairing.destinations?.join(' → ') || dest;
  } catch {}
  const kitchenOptions = [
    { key: 'hotel', emoji: '🏨', label: 'Hotel / No Kitchen' },
    { key: 'microwave', emoji: '📦', label: 'Microwave Only' },
    { key: 'fridge', emoji: '❄️', label: 'Fridge Available' },
    { key: 'airplane_food', emoji: '✈️', label: 'Crew Meals on Board' },
  ];
  const checkboxHtml = kitchenOptions.map(({ key, emoji, label }) =>
    `<label style="display:flex;align-items:center;gap:12px;margin:10px 0;padding:16px 20px;background:#152850;border:2px solid #1E3A6E;border-radius:12px;color:#F8FAFF;font-size:16px;font-weight:600;cursor:pointer;">
      <input type="checkbox" name="kitchen" value="${key}" style="width:20px;height:20px;accent-color:#C9A84C;flex-shrink:0;">
      ${emoji} ${label}
    </label>`
  ).join('');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NutriCrew</title></head><body style="margin:0;padding:0;background:#07101E;font-family:system-ui,sans-serif;"><div style="max-width:520px;margin:0 auto;padding:32px 16px;"><div style="background:#0F2040;border-radius:20px;overflow:hidden;"><div style="background:linear-gradient(135deg,#0A1628,#152850);padding:28px 32px;text-align:center;border-bottom:1px solid #1E3A6E;"><div style="font-size:36px;">✈️</div><div style="color:#C9A84C;font-size:22px;font-weight:700;margin-top:8px;">NutriCrew</div><div style="color:#7A8EAA;font-size:13px;margin-top:4px;">Your pairing starts tomorrow</div></div><div style="padding:32px;"><p style="color:#F8FAFF;font-size:16px;font-weight:600;margin:0 0 16px;">What's your kitchen situation for <strong style="color:#E8C96A;">${dest}</strong>?</p><p style="color:#7A8EAA;font-size:13px;margin:0 0 16px;">Select all that apply.</p><form method="get" action="/api/roster/confirm-kitchen"><input type="hidden" name="token" value="${token}">${checkboxHtml}<button type="submit" style="display:block;width:100%;margin-top:20px;padding:16px 24px;background:#C9A84C;border:none;border-radius:12px;color:#07101E;font-size:16px;font-weight:700;cursor:pointer;">Confirm →</button></form><p style="color:#7A8EAA;font-size:13px;margin:24px 0 0;text-align:center;">Your personalised meal plan lands in your inbox within 30 seconds.</p></div></div></div></body></html>`);
});

// ── EXTRAS CACHE ──────────────────────────────────────────────────────────────

app.post('/api/extras-cache/query', requireInternal, async (req, res) => {
  try {
    const { dietKey, goalKey, budgetLevel, kitchenKey, calorieTargetKey, lang, destinationKey, goingUsa, pairingDays } = req.body;
    const doc = await CachedExtras.findOne(
      { dietKey, goalKey, budgetLevel, kitchenKey, calorieTargetKey, lang, destinationKey, goingUsa, pairingDays }
    ).lean();
    res.json({ hit: !!doc, extras: doc ? { summary: doc.summary, groceryList: doc.groceryList, foodRestrictions: doc.foodRestrictions } : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/extras-cache/store', requireInternal, async (req, res) => {
  try {
    const { dietKey, goalKey, budgetLevel, kitchenKey, calorieTargetKey, lang, destinationKey, goingUsa, pairingDays, summary, groceryList, foodRestrictions } = req.body;
    await CachedExtras.findOneAndUpdate(
      { dietKey, goalKey, budgetLevel, kitchenKey, calorieTargetKey, lang, destinationKey, goingUsa, pairingDays },
      { $set: { summary, groceryList, foodRestrictions, createdAt: new Date() } },
      { upsert: true, new: true }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Catches malformed JSON bodies and anything else that escapes a route's own
// try/catch, so Express's default handler (which can include stack traces
// when NODE_ENV isn't "production") never sends raw error details to clients.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// --- Startup ---

mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });
