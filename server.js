require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const FREE_PAIRING_LIMIT = 3;

app.use(cors());
app.use(express.json());

// --- Models ---

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    pairingCount: { type: Number, default: 0 },
    isPremium: { type: Boolean, default: false },
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
app.post('/api/users', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email and password are required' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashedPassword });
    const { password: _password, ...userData } = user.toObject();
    res.status(201).json(userData);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Email already in use' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: 'Invalid user id' });
  }
});

app.put('/api/users/:id', async (req, res) => {
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
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(400).json({ error: 'Invalid user id' });
  }
});

// Pairing usage (free-tier enforcement for the AI plan generator)
app.post('/api/pairing-usage/check', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const normalizedEmail = email.toLowerCase().trim();
    let user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      const placeholderPassword = await bcrypt.hash(crypto.randomUUID(), 10);
      user = await User.create({ name: name || normalizedEmail, email: normalizedEmail, password: placeholderPassword });
    }

    const allowed = user.isPremium || user.pairingCount < FREE_PAIRING_LIMIT;
    res.json({ allowed, pairingCount: user.pairingCount, isPremium: user.isPremium });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pairing-usage/increment', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOneAndUpdate(
      { email: normalizedEmail },
      { $inc: { pairingCount: 1 } },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ pairingCount: user.pairingCount, isPremium: user.isPremium });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Meals
app.post('/api/meals', async (req, res) => {
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

app.get('/api/meals', async (req, res) => {
  try {
    const meals = await Meal.find();
    res.json(meals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/meals/:id', async (req, res) => {
  try {
    const meal = await Meal.findById(req.params.id);
    if (!meal) return res.status(404).json({ error: 'Meal not found' });
    res.json(meal);
  } catch (err) {
    res.status(400).json({ error: 'Invalid meal id' });
  }
});

app.put('/api/meals/:id', async (req, res) => {
  try {
    const meal = await Meal.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!meal) return res.status(404).json({ error: 'Meal not found' });
    res.json(meal);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/meals/:id', async (req, res) => {
  try {
    const meal = await Meal.findByIdAndDelete(req.params.id);
    if (!meal) return res.status(404).json({ error: 'Meal not found' });
    res.json({ message: 'Meal deleted' });
  } catch (err) {
    res.status(400).json({ error: 'Invalid meal id' });
  }
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
