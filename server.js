require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const FREE_PAIRING_LIMIT = 1;
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
  },
  { timestamps: true }
);

const User = mongoose.model('User', userSchema);

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

    const expiry = new Date(Date.now() + 10 * 60 * 1000);
    let user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      const ph = await bcrypt.hash(crypto.randomUUID(), 10);
      user = await User.create({ name: normalizedEmail.split('@')[0], email: normalizedEmail, password: ph });
    }
    await User.updateOne({ email: normalizedEmail }, { otpHash, otpExpiry: expiry, otpAttempts: 0 });
    res.json({ ok: true });
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
