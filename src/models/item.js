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

    const subcategoryIds = [
      ...new Set(items.map((item) => item.subcategory_id)),
    ];

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

    const { data: activeCategories } = await db
      .from("categories")
      .select("id")
      .eq("is_active", true)
      .in("id", categoryIds);

    const activeCategoryIds = new Set(activeCategories?.map((c) => c.id) || []);

    const validSubcategoryIds = new Set(
      activeSubcategories
        .filter((sub) => activeCategoryIds.has(sub.parent_id))
        .map((sub) => sub.id)
    );

    const filteredItems = items.filter((item) =>
      validSubcategoryIds.has(item.subcategory_id)
    );

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

  // ✅ COMPLETE: All 5 pricing types implemented
  async calculatePrice(itemId, requestParams = {}) {
    const { data: item } = await db
      .from("items")
      .select("*")
      .eq("id", itemId)
      .single();
    
    if (!item) return { error: "Item not found" };

    const rules = item.pricing_rules || {};
    let basePrice = 0;
    let appliedRule = item.pricing_type;
    let discount = 0;
    let discountReason = null;

    // ========================================
    // PRICING TYPE LOGIC
    // ========================================
    switch (item.pricing_type) {
      case "static":
        basePrice = parseFloat(rules.base_price || 0);
        appliedRule = "static";
        break;

      case "complimentary":
        basePrice = 0;
        appliedRule = "complimentary (free)";
        break;

      case "tiered": {
        const duration = parseFloat(requestParams.duration_hours) || 1;
        basePrice = parseFloat(rules.base_price || 0);

        if (rules.tiers && rules.tiers.length > 0) {
          const tier = rules.tiers.find((t) => duration <= t.max_hours);
          if (tier) {
            basePrice = parseFloat(tier.price);
            appliedRule = `tiered (${duration}h)`;
          } else {
            appliedRule = `tiered (${duration}h, using base)`;
          }
        }
        break;
      }

      case "discounted": {
        basePrice = parseFloat(rules.base_price || 0);
        const discountType = rules.discount_type;
        const discountValue = parseFloat(rules.discount_value || 0);

        if (discountType === "flat") {
          discount = discountValue;
          discountReason = `Flat discount of ₹${discountValue}`;
        } else if (discountType === "percentage") {
          discount = (basePrice * discountValue) / 100;
          discountReason = `${discountValue}% discount`;
        }

        // Ensure discount never exceeds base price
        if (discount > basePrice) {
          discount = basePrice;
        }

        appliedRule = `discounted (${discountType})`;
        break;
      }

      case "dynamic": {
        const currentTime = requestParams.current_time || 
                           new Date().toTimeString().slice(0, 5);
        basePrice = parseFloat(rules.base_price || 0);

        const timeWindows = rules.time_windows || [];
        let matchedWindow = null;

        for (const window of timeWindows) {
          if (currentTime >= window.start_time && currentTime <= window.end_time) {
            matchedWindow = window;
            break;
          }
        }

        if (matchedWindow) {
          basePrice = parseFloat(matchedWindow.price);
          appliedRule = `dynamic (${matchedWindow.start_time}-${matchedWindow.end_time})`;
        } else {
          return {
            error: "Item not available at this time",
            current_time: currentTime,
            available_windows: timeWindows,
          };
        }
        break;
      }

      default:
        return { error: `Unknown pricing type: ${item.pricing_type}` };
    }

    // ========================================
    // TAX CALCULATION
    // ========================================
    const tax = await this.getEffectiveTax(itemId);
    const subtotal = basePrice - discount;
    
    let taxAmount = 0;
    if (tax.tax_applicable) {
      taxAmount = (subtotal * parseFloat(tax.tax_percentage)) / 100;
    }

    const finalPrice = subtotal + taxAmount;

    // ========================================
    // RETURN BREAKDOWN
    // ========================================
    return {
      item_id: itemId,
      item_name: item.name,
      pricing_type: item.pricing_type,
      applied_rule: appliedRule,
      request_params: requestParams,
      base_price: basePrice.toFixed(2),
      discount: discount > 0 ? discount.toFixed(2) : null,
      discount_reason: discountReason,
      subtotal: subtotal.toFixed(2),
      tax_applicable: tax.tax_applicable,
      tax_percentage: tax.tax_percentage,
      tax_amount: taxAmount.toFixed(2),
      final_price: finalPrice.toFixed(2),
    };
  },

  // ✅ Tax inheritance: subcategory → category
  async getEffectiveTax(itemId) {
    const { data: item } = await db
      .from("items")
      .select("subcategory_id")
      .eq("id", itemId)
      .single();

    if (!item) return { tax_applicable: false, tax_percentage: 0 };

    const { data: subcategory } = await db
      .from("subcategories")
      .select("parent_id, tax_applicable, tax_percentage")
      .eq("id", item.subcategory_id)
      .single();

    if (!subcategory) return { tax_applicable: false, tax_percentage: 0 };

    // If subcategory has tax defined, use it
    if (subcategory.tax_applicable) {
      return {
        tax_applicable: true,
        tax_percentage: subcategory.tax_percentage,
        inherited_from: "subcategory",
      };
    }

    // Otherwise, check category
    const { data: category } = await db
      .from("categories")
      .select("tax_applicable, tax_percentage")
      .eq("id", subcategory.parent_id)
      .single();

    if (category && category.tax_applicable) {
      return {
        tax_applicable: true,
        tax_percentage: category.tax_percentage,
        inherited_from: "category",
      };
    }

    return { tax_applicable: false, tax_percentage: 0 };
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

    let query = db.from("items").select("*");

    if (active_only === true || active_only === "true") {
      query = query.eq("is_active", true);
    }

    if (search) {
      query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%`);
    }

    if (subcategory_id) {
      query = query.eq("subcategory_id", subcategory_id);
    }

    const validSortFields = ["name", "created_at"];
    const sortField = validSortFields.includes(sort_by) ? sort_by : "name";
    const ascending = sort_order === "asc";
    query = query.order(sortField, { ascending });

    query = query.range(from, to);

    const { data: items, error } = await query;

    if (error) {
      return { error: error.message };
    }

    let filteredItems = items || [];

    if (filteredItems.length > 0) {
      const subcategoryIds = [
        ...new Set(filteredItems.map((item) => item.subcategory_id)),
      ];

      const { data: subcategories } = await db
        .from("subcategories")
        .select("id, parent_id, is_active")
        .in("id", subcategoryIds);

      const activeSubcategories =
        subcategories?.filter((s) => s.is_active) || [];
      const categoryIds = [
        ...new Set(activeSubcategories.map((s) => s.parent_id)),
      ];

      const { data: categories } = await db
        .from("categories")
        .select("id, is_active")
        .in("id", categoryIds);

      const activeCategoryIds = new Set(
        categories?.filter((c) => c.is_active).map((c) => c.id) || []
      );

      const validSubcategoryIds = new Set(
        activeSubcategories
          .filter((sub) => activeCategoryIds.has(sub.parent_id))
          .map((sub) => sub.id)
      );

      filteredItems = filteredItems.filter((item) =>
        validSubcategoryIds.has(item.subcategory_id)
      );
    }

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
