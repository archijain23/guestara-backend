// src/models/restaurant.js
const db = require("../config/db");

const Restaurant = {
  async create(payload) {
    const { data, error } = await db
      .from("restaurants")
      .insert([payload])
      .select()
      .single();
    return { data, error };
  },

  async list({ page = 1, limit = 10 } = {}) {
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data, error } = await db
      .from("restaurants")
      .select("*")
      .order("created_at", { ascending: true })
      .range(from, to);

    return { data, error };
  },
};

module.exports = Restaurant;
