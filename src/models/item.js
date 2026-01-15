const db = require("../config/db");

const Item = {
  async create(payload) {
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
  async update(id, payload) {
    // Validate pricing_type if provided
    if (payload.pricing_type) {
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
    }

    const { data, error } = await db
      .from("items")
      .update(payload)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return { error: error.message };
    }

    return { data };
  },

  async list({ subcategory_id, category_id, page = 1, limit = 10 } = {}) {
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // Get active items
    let query = db
      .from("items")
      .select("*")
      .eq("is_active", true)
      .order("name")
      .range(from, to);

    if (subcategory_id) {
      query = query.eq("subcategory_id", subcategory_id);
    }

    const { data: items, error } = await query;

    if (error) {
      return { error };
    }

    if (!items || items.length === 0) {
      return { data: [], error: null };
    }

    // ✅ Checkpoint 10: Manual cascade filtering
    // Step 1: Get subcategory IDs from items
    const subcategoryIds = [
      ...new Set(items.map((item) => item.subcategory_id)),
    ];

    // Step 2: Get active subcategories
    const { data: activeSubcategories } = await db
      .from("subcategories")
      .select("id, parent_id")
      .eq("is_active", true)
      .in("id", subcategoryIds);

    if (!activeSubcategories || activeSubcategories.length === 0) {
      return { data: [], error: null };
    }

    const activeSubcategoryIds = new Set(activeSubcategories.map((s) => s.id));
    const categoryIds = [
      ...new Set(activeSubcategories.map((s) => s.parent_id)),
    ];

    // Step 3: Get active categories
    const { data: activeCategories } = await db
      .from("categories")
      .select("id")
      .eq("is_active", true)
      .in("id", categoryIds);

    const activeCategoryIds = new Set(activeCategories?.map((c) => c.id) || []);

    // Step 4: Filter subcategories that have active parent categories
    const validSubcategoryIds = new Set(
      activeSubcategories
        .filter((sub) => activeCategoryIds.has(sub.parent_id))
        .map((sub) => sub.id)
    );

    // Step 5: Filter items to only those with valid subcategories
    const filteredItems = items.filter((item) =>
      validSubcategoryIds.has(item.subcategory_id)
    );

    // Optional: Filter by category_id if provided
    if (category_id) {
      const subcategoriesInCategory = activeSubcategories
        .filter((sub) => sub.parent_id === category_id)
        .map((sub) => sub.id);

      return {
        data: filteredItems.filter((item) =>
          subcategoriesInCategory.includes(item.subcategory_id)
        ),
        error: null,
      };
    }

    return { data: filteredItems, error: null };
  },

  async calculatePrice(itemId, requestParams = {}) {
    const { data: item } = await db
      .from("items")
      .select("*")
      .eq("id", itemId)
      .single();
    if (!item) return { error: "Item not found" };

    const tax = await this.getEffectiveTax(itemId);
    let basePrice = 0;
    let appliedRule = "unknown";

    const rules = item.pricing_rules;

    switch (item.pricing_type) {
      case "static":
        basePrice = rules.base_price || 0;
        appliedRule = "static";
        break;

      case "complimentary":
        basePrice = 0;
        appliedRule = "complimentary";
        break;

      case "tiered":
        const duration = requestParams.duration_hours || 1;
        const tiers = rules.tiers || [];
        const tier = tiers.find((t) => duration <= t.max_hours);
        basePrice = tier ? tier.price : rules.base_price || 0;
        appliedRule = `tiered (${duration}h)`;
        break;

      default:
        basePrice = rules.base_price || 0;
        appliedRule = item.pricing_type;
    }

    const subtotal = basePrice;
    const taxAmount = subtotal * (tax.tax_percentage / 100);
    const finalPrice = subtotal + taxAmount;

    return {
      item_name: item.name,
      pricing_type: item.pricing_type,
      applied_rule: appliedRule,
      request_params: requestParams,
      base_price: basePrice.toFixed(2),
      subtotal: subtotal.toFixed(2),
      tax_applicable: tax.tax_applicable,
      tax_percentage: tax.tax_percentage,
      tax_amount: taxAmount.toFixed(2),
      final_price: finalPrice.toFixed(2),
    };
  },

  async getAvailability(itemId, date = null) {
    const query = db
      .from("availability_slots")
      .select("id, start_time, end_time, capacity, is_booked, created_at")
      .eq("item_id", itemId)
      .order("start_time");

    if (date) query.eq("date", date);

    const { data, error } = await query;
    if (error) return { error: error.message };

    return data.map((slot) => ({
      id: slot.id,
      slot: `${slot.start_time.slice(0, 5)}-${slot.end_time.slice(0, 5)}`,
      available: !slot.is_booked && slot.capacity > 0,
      capacity_left: slot.capacity,
      date: date || null,
    }));
  },

  async getAddons(itemId) {
    const { data, error } = await db
      .from("item_addons")
      .select("id, name, description, price, max_quantity, is_active")
      .eq("item_id", itemId)
      .eq("is_active", true)
      .order("price");

    if (error) return { error: error.message };

    return data.map((addon) => ({
      id: addon.id,
      name: addon.name,
      description: addon.description || null,
      price: addon.price.toFixed(2),
      max_quantity: addon.max_quantity,
    }));
  },

  async searchItems(params = {}) {
    const {
      search,
      min_price,
      max_price,
      subcategory_id,
      category_id,
      active_only = true,
      sort_by = "name",
      sort_order = "asc",
      page = 1,
      limit = 10,
    } = params;

    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // Build query
    let query = db.from("items").select("*");

    // Active filter
    if (active_only === true || active_only === "true") {
      query = query.eq("is_active", true);
    }

    // Text search
    if (search) {
      query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%`);
    }

    // Subcategory filter
    if (subcategory_id) {
      query = query.eq("subcategory_id", subcategory_id);
    }

    // Sorting
    const validSortFields = ["name", "created_at"];
    const sortField = validSortFields.includes(sort_by) ? sort_by : "name";
    const ascending = sort_order === "asc";
    query = query.order(sortField, { ascending });

    // Pagination
    query = query.range(from, to);

    const { data: items, error } = await query;

    if (error) {
      return { error: error.message };
    }

    let filteredItems = items || [];

    // ✅ Checkpoint 10: Manual cascade filtering
    if (filteredItems.length > 0) {
      // Get subcategories for these items
      const subcategoryIds = [
        ...new Set(filteredItems.map((item) => item.subcategory_id)),
      ];

      const { data: subcategories } = await db
        .from("subcategories")
        .select("id, parent_id, is_active")
        .in("id", subcategoryIds);

      // Filter out items with inactive subcategories
      const activeSubcategories =
        subcategories?.filter((s) => s.is_active) || [];
      const categoryIds = [
        ...new Set(activeSubcategories.map((s) => s.parent_id)),
      ];

      // Get active categories
      const { data: categories } = await db
        .from("categories")
        .select("id, is_active")
        .in("id", categoryIds);

      const activeCategoryIds = new Set(
        categories?.filter((c) => c.is_active).map((c) => c.id) || []
      );

      // Valid subcategories = active subcategories with active parent categories
      const validSubcategoryIds = new Set(
        activeSubcategories
          .filter((sub) => activeCategoryIds.has(sub.parent_id))
          .map((sub) => sub.id)
      );

      // Filter items
      filteredItems = filteredItems.filter((item) =>
        validSubcategoryIds.has(item.subcategory_id)
      );
    }

    // Category filter
    if (category_id && filteredItems.length > 0) {
      const subcategoryIds = [
        ...new Set(filteredItems.map((item) => item.subcategory_id)),
      ];

      const { data: subcategories } = await db
        .from("subcategories")
        .select("id, parent_id")
        .in("id", subcategoryIds)
        .eq("parent_id", category_id);

      const validSubIds = new Set(subcategories?.map((s) => s.id) || []);
      filteredItems = filteredItems.filter((item) =>
        validSubIds.has(item.subcategory_id)
      );
    }

    // Price filtering
    if (min_price !== undefined || max_price !== undefined) {
      filteredItems = filteredItems.filter((item) => {
        const basePrice = item.pricing_rules?.base_price;
        if (basePrice === null || basePrice === undefined) return false;

        const price = parseFloat(basePrice);
        const min = min_price ? parseFloat(min_price) : 0;
        const max = max_price ? parseFloat(max_price) : Infinity;

        return price >= min && price <= max;
      });
    }

    const formattedItems = filteredItems.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      image: item.image,
      pricing_type: item.pricing_type,
      base_price: item.pricing_rules?.base_price || null,
      subcategory_id: item.subcategory_id,
      is_active: item.is_active,
      created_at: item.created_at,
    }));

    return {
      data: formattedItems,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: formattedItems.length,
        has_more: formattedItems.length === limit,
      },
    };
  },
};

module.exports = Item;
