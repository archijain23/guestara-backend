const db = require("../config/db");

const Category = {
  // POST /categories
  async create(payload) {
    // Business rule validation
    if (payload.tax_applicable && !payload.tax_percentage) {
      return {
        error: {
          message: "tax_percentage required when tax_applicable is true",
        },
      };
    }

    const { data, error } = await db
      .from("categories")
      .insert([payload])
      .select()
      .single();

    return { data, error };
  },

  // GET /categories?restaurant_id=...
  async list({ restaurant_id, page = 1, limit = 10 } = {}) {
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = db
      .from("categories")
      .select("*")
      .eq("is_active", true)
      .order("name", { ascending: true })
      .range(from, to);

    // Filter by restaurant (required by spec)
    if (restaurant_id) {
      query = query.eq("restaurant_id", restaurant_id);
    }

    const { data, error } = await query;
    return { data, error };
  },
};

module.exports = Category;
