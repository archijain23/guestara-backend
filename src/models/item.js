const db = require("../config/db");

const Item = {
  async create(payload) {
    // Validate pricing_type enum
    const validTypes = [
      "static",
      "tiered",
      "complimentary",
      "discounted",
      "dynamic",
    ];
    if (!validTypes.includes(payload.pricing_type)) {
      return {
        error: {
          message: `pricing_type must be one of: ${validTypes.join(", ")}`,
        },
      };
    }

    const { data, error } = await db
      .from("items")
      .insert([payload])
      .select()
      .single();
    return { data, error };
  },

  async list({ subcategory_id, page = 1, limit = 10 } = {}) {
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = db
      .from("items")
      .select("*")
      .eq("is_active", true)
      .order("name")
      .range(from, to);

    if (subcategory_id) query = query.eq("subcategory_id", subcategory_id);

    const { data, error } = await query;
    return { data, error };
  },
};

module.exports = Item;
