const db = require("../config/db");

const Subcategory = {
  async create(payload) {
    // Verify parent category exists and is active
    const { data: category } = await db
      .from("categories")
      .select("id, is_active")
      .eq("id", payload.parent_id)
      .single();

    if (!category) {
      return {
        error: { message: "Parent category not found" },
      };
    }

    if (!category.is_active) {
      return {
        error: { message: "Cannot add subcategory to inactive category" },
      };
    }

    const { data, error } = await db
      .from("subcategories")
      .insert([payload])
      .select()
      .single();

    return { data, error };
  },

  async update(id, payload) {
    const { data, error } = await db
      .from("subcategories")
      .update(payload)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return { error: error.message };
    }

    return { data };
  },

  // ✅ Checkpoint 10: Cascade filter - only show subcategories with active parent
  async list({ category_id, page = 1, limit = 10 } = {}) {
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // Get all active subcategories
    let query = db
      .from("subcategories")
      .select("*")
      .eq("is_active", true)
      .order("name", { ascending: true })
      .range(from, to);

    if (category_id) {
      query = query.eq("parent_id", category_id);
    }

    const { data: subcategories, error } = await query;

    if (error) {
      return { error };
    }

    // ✅ Manual cascade: Filter out subcategories with inactive parent categories
    const subcategoryIds = subcategories.map((s) => s.parent_id);

    if (subcategoryIds.length === 0) {
      return { data: [], error: null };
    }

    const { data: activeCategories } = await db
      .from("categories")
      .select("id")
      .eq("is_active", true)
      .in("id", subcategoryIds);

    const activeCategoryIds = new Set(activeCategories?.map((c) => c.id) || []);

    // Filter subcategories to only those with active parent categories
    const filteredSubcategories = subcategories.filter((sub) =>
      activeCategoryIds.has(sub.parent_id)
    );

    return { data: filteredSubcategories, error: null };
  },
};

module.exports = Subcategory;
