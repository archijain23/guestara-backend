const express = require("express");
const db = require("./config/db");
const app = express();
const Restaurant = require("./models/restaurant");
const Category = require("./models/category");
const Item = require("./models/item");

app.use(express.json());

app.get("/health", async (req, res) => {
  const { data: restaurants, error } = await db
    .from("restaurants")
    .select("id")
    .limit(1);
  res.json({
    status: "OK",
    connected: !error && restaurants?.length >= 0,
    restaurant_count: restaurants?.length || 0,
    error: error?.message || null,
  });
});

// Create restaurant
app.post("/restaurants", async (req, res) => {
  const { data, error } = await Restaurant.create(req.body);
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// List restaurants with pagination
app.get("/restaurants", async (req, res) => {
  const page = parseInt(req.query.page || "1", 10);
  const limit = parseInt(req.query.limit || "10", 10);

  const { data, error } = await Restaurant.list({ page, limit });
  if (error) return res.status(400).json({ error: error.message });

  res.json({ page, limit, data });
});

// POST /categories
app.post("/categories", async (req, res) => {
  const { data, error } = await Category.create(req.body);
  if (error && !error.data) {
    return res.status(400).json({ error: error.message });
  }
  res.status(201).json(data);
});

// GET /categories?restaurant_id=...
app.get("/categories", async (req, res) => {
  const restaurant_id = req.query.restaurant_id;
  const page = parseInt(req.query.page || "1", 10);
  const limit = parseInt(req.query.limit || "10", 10);

  const { data, error } = await Category.list({ restaurant_id, page, limit });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ page, limit, data });
});

// POST /items (create item with pricing_rules)
app.post("/items", async (req, res) => {
  const { data, error } = await Item.create(req.body);
  if (error && !error.data) {
    return res.status(400).json({ error: error.message });
  }
  res.status(201).json(data);
});

// GET /items?subcategory_id=... (pagination)
app.get("/items", async (req, res) => {
  const subcategory_id = req.query.subcategory_id;
  const page = parseInt(req.query.page || "1", 10);
  const limit = parseInt(req.query.limit || "10", 10);

  const { data, error } = await Item.list({ subcategory_id, page, limit });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ page, limit, data });
});

app.get("/items/:id/tax", async (req, res) => {
  console.log("🌐 Route hit:", req.params.id);
  const result = await Item.getEffectiveTax(req.params.id);
  console.log("📤 Returning:", result);
  res.json(result || { error: "No data" });
});

// REQUIRED: GET /items/:id/price
app.get("/items/:id/price", async (req, res) => {
  const duration = parseFloat(req.query.duration_hours) || null; // For tiered
  const result = await Item.calculatePrice(req.params.id, {
    duration_hours: duration,
  });

  if (result.error) return res.status(404).json({ error: result.error });
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
