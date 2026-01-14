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

  async getEffectiveTax(itemId) {
    const { data: item } = await db
      .from("items")
      .select("subcategory_id")
      .eq("id", itemId)
      .single();
    if (!item) return { tax_applicable: false, tax_percentage: 0 };

    const { data: subcat } = await db
      .from("subcategories")
      .select("parent_id, tax_applicable, tax_percentage")
      .eq("id", item.subcategory_id)
      .single();
    const { data: cat } = await db
      .from("categories")
      .select("tax_applicable, tax_percentage")
      .eq("id", subcat.parent_id)
      .single();

    const taxApplicable =
      cat?.tax_applicable || subcat?.tax_applicable || false;
    const taxPercentage = cat?.tax_percentage || subcat?.tax_percentage || 0;

    return { tax_applicable: taxApplicable, tax_percentage: taxPercentage };
  },
};

module.exports = Item;
