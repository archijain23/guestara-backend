const express = require("express");
const db = require("./config/db");
const app = express();
const Restaurant = require("./models/restaurant");

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
