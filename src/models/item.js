const db = require("../config/db");

const Item = {
  async create(payload) {
    // Validate parent reference - item must belong to EITHER category OR subcategory
    const hasCategory = payload.category_id != null;
    const hasSubcategory = payload.subcategory_id != null;

    if (hasCategory && hasSubcategory) {
      return {
        error: {
          message: "Item cannot belong to both category and subcategory. Choose one.",
        },
      };
    }

    if (!hasCategory && !hasSubcategory) {
      return {
        error: {
          message: "Item must belong to either a category or subcategory.",
        },
      };
    }

    // Validate pricing type
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

    // Validate complimentary pricing rules
    if (payload.pricing_type === "complimentary") {
      if (payload.pricing_rules && payload.pricing_rules.base_price !== undefined) {
        return {
          error: {
            message: "Complimentary items cannot have a base_price. They are always free.",
          },
        };
      }
    }

    const { data, error } = await db
      .from("items")
      .insert([payload])
      .select()
      .single();
    return { data, error };
  },

  async update(id, payload) {
    // If updating parent reference, validate
    if (payload.category_id !== undefined || payload.subcategory_id !== undefined) {
      const hasCategory = payload.category_id != null;
      const hasSubcategory = payload.subcategory_id != null;

      if (hasCategory && hasSubcategory) {
        return {
          error: {
            message: "Item cannot belong to both category and subcategory.",
          },
        };
      }
    }

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

    // Validate complimentary pricing rules
    if (payload.pricing_type === "complimentary") {
      if (payload.pricing_rules && payload.pricing_rules.base_price !== undefined) {
        return {
          error: {
            message: "Complimentary items cannot have a base_price. They are always free.",
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
      // Get items that belong to a specific subcategory
      query = query.eq("subcategory_id", subcategory_id);
    } else if (category_id) {
      // Get items that belong directly to a category (no subcategory)
      query = query.eq("category_id", category_id).is("subcategory_id", null);
    }

    const { data: items, error } = await query;

    if (error) {
      return { error };
    }

    if (!items || items.length === 0) {
      return { data: [], error: null };
    }

    // Filter items based on parent active status
    const itemsWithSubcategory = items.filter((item) => item.subcategory_id);
    const itemsWithCategory = items.filter(
      (item) => item.category_id && !item.subcategory_id
    );

    let validItems = [];

    // Check items with subcategory
    if (itemsWithSubcategory.length > 0) {
      const subcategoryIds = [
        ...new Set(itemsWithSubcategory.map((item) => item.subcategory_id)),
      ];

      const { data: activeSubcategories } = await db
        .from("subcategories")
        .select("id, parent_id")
        .eq("is_active", true)
        .in("id", subcategoryIds);

      if (activeSubcategories && activeSubcategories.length > 0) {
        const activeSubcategoryIds = new Set(
          activeSubcategories.map((s) => s.id)
        );
        const categoryIds = [
          ...new Set(activeSubcategories.map((s) => s.parent_id)),
        ];

        const { data: activeCategories } = await db
          .from("categories")
          .select("id")
          .eq("is_active", true)
          .in("id", categoryIds);

        const activeCategoryIds = new Set(
          activeCategories?.map((c) => c.id) || []
        );

        const validSubcategoryIds = new Set(
          activeSubcategories
            .filter((sub) => activeCategoryIds.has(sub.parent_id))
            .map((sub) => sub.id)
        );

        validItems = validItems.concat(
          itemsWithSubcategory.filter((item) =>
            validSubcategoryIds.has(item.subcategory_id)
          )
        );
      }
    }

    // Check items with direct category
    if (itemsWithCategory.length > 0) {
      const categoryIds = [
        ...new Set(itemsWithCategory.map((item) => item.category_id)),
      ];

      const { data: activeCategories } = await db
        .from("categories")
        .select("id")
        .eq("is_active", true)
        .in("id", categoryIds);

      const activeCategoryIds = new Set(
        activeCategories?.map((c) => c.id) || []
      );

      validItems = validItems.concat(
        itemsWithCategory.filter((item) =>
          activeCategoryIds.has(item.category_id)
        )
      );
    }

    return { data: validItems, error: null };
  },

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

    switch (item.pricing_type) {
      case "static":
        basePrice = parseFloat(rules.base_price || 0);
        appliedRule = "static";
        break;

      case "complimentary":
        // Always free, ignore any base_price if present
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
          discountReason = `Flat discount of Rs.${discountValue}`;
        } else if (discountType === "percentage") {
          discount = (basePrice * discountValue) / 100;
          discountReason = `${discountValue}% discount`;
        }

        if (discount > basePrice) {
          discount = basePrice;
        }

        appliedRule = `discounted (${discountType})`;
        break;
      }

      case "dynamic": {
        const currentTime =
          requestParams.current_time || new Date().toTimeString().slice(0, 5);
        basePrice = parseFloat(rules.base_price || 0);

        const timeWindows = rules.time_windows || [];
        let matchedWindow = null;

        for (const window of timeWindows) {
          if (
            currentTime >= window.start_time &&
            currentTime <= window.end_time
          ) {
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

    const tax = await this.getEffectiveTax(itemId);
    const subtotal = basePrice - discount;

    let taxAmount = 0;
    if (tax.tax_applicable) {
      taxAmount = (subtotal * parseFloat(tax.tax_percentage)) / 100;
    }

    const finalPrice = subtotal + taxAmount;

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

  // Updated tax inheritance: handles both category and subcategory parents
  async getEffectiveTax(itemId) {
    const { data: item } = await db
      .from("items")
      .select("category_id, subcategory_id")
      .eq("id", itemId)
      .single();

    if (!item) return { tax_applicable: false, tax_percentage: 0 };

    // Case 1: Item belongs directly to a category
    if (item.category_id && !item.subcategory_id) {
      const { data: category } = await db
        .from("categories")
        .select("tax_applicable, tax_percentage")
        .eq("id", item.category_id)
        .single();

      if (category && category.tax_applicable) {
        return {
          tax_applicable: true,
          tax_percentage: category.tax_percentage,
          inherited_from: "category",
        };
      }

      return { tax_applicable: false, tax_percentage: 0 };
    }

    // Case 2: Item belongs to a subcategory
    if (item.subcategory_id) {
      const { data: subcategory } = await db
        .from("subcategories")
        .select("parent_id, tax_applicable, tax_percentage")
        .eq("id", item.subcategory_id)
        .single();

      if (!subcategory)
        return { tax_applicable: false, tax_percentage: 0 };

      // If subcategory has tax defined, use it
      if (subcategory.tax_applicable) {
        return {
          tax_applicable: true,
          tax_percentage: subcategory.tax_percentage,
          inherited_from: "subcategory",
        };
      }

      // Otherwise, check parent category
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
    }

    return { tax_applicable: false, tax_percentage: 0 };
  },

  // Create availability slots for an item
  async createAvailabilitySlot(itemId, slotData) {
    const { date, start_time, end_time, capacity = 1 } = slotData;

    if (!date || !start_time || !end_time) {
      return { error: "date, start_time, and end_time are required" };
    }

    // Validate time format (HH:MM)
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(start_time) || !timeRegex.test(end_time)) {
      return { error: "Invalid time format. Use HH:MM (e.g., 09:00, 14:30)" };
    }

    // Check for time conflicts
    const { data: existingSlots } = await db
      .from("availability_slots")
      .select("*")
      .eq("item_id", itemId)
      .eq("date", date);

    if (existingSlots && existingSlots.length > 0) {
      for (const slot of existingSlots) {
        const existingStart = slot.start_time.slice(0, 5);
        const existingEnd = slot.end_time.slice(0, 5);

        // Check if new slot overlaps with existing slot
        const hasConflict =
          (start_time >= existingStart && start_time < existingEnd) ||
          (end_time > existingStart && end_time <= existingEnd) ||
          (start_time <= existingStart && end_time >= existingEnd);

        if (hasConflict) {
          return {
            error: `Time conflict with existing slot: ${existingStart}-${existingEnd}`,
            existing_slot: {
              id: slot.id,
              time: `${existingStart}-${existingEnd}`,
            },
          };
        }
      }
    }

    // Create the slot
    const { data, error } = await db
      .from("availability_slots")
      .insert([
        {
          item_id: itemId,
          date,
          start_time,
          end_time,
          capacity,
          is_booked: false,
        },
      ])
      .select()
      .single();

    if (error) return { error: error.message };

    return {
      data: {
        id: data.id,
        date: data.date,
        slot: `${data.start_time.slice(0, 5)}-${data.end_time.slice(0, 5)}`,
        capacity: data.capacity,
        is_booked: data.is_booked,
      },
    };
  },

  async getAvailability(itemId, date = null) {
    const query = db
      .from("availability_slots")
      .select("id, date, start_time, end_time, capacity, is_booked, created_at")
      .eq("item_id", itemId)
      .order("date")
      .order("start_time");

    if (date) query.eq("date", date);

    const { data, error } = await query;
    if (error) return { error: error.message };

    return data.map((slot) => ({
      id: slot.id,
      date: slot.date,
      slot: `${slot.start_time.slice(0, 5)}-${slot.end_time.slice(0, 5)}`,
      available: !slot.is_booked && slot.capacity > 0,
      capacity_left: slot.capacity,
    }));
  },

  // Book a slot
  async bookSlot(slotId) {
    // First, check if slot exists and is available
    const { data: slot, error: fetchError } = await db
      .from("availability_slots")
      .select("*")
      .eq("id", slotId)
      .single();

    if (fetchError) {
      return { error: "Slot not found" };
    }

    // Prevent double booking
    if (slot.is_booked) {
      return {
        error: "This slot is already booked",
        slot: {
          id: slot.id,
          date: slot.date,
          time: `${slot.start_time.slice(0, 5)}-${slot.end_time.slice(0, 5)}`,
          status: "booked",
        },
      };
    }

    // Check capacity
    if (slot.capacity <= 0) {
      return {
        error: "No capacity left for this slot",
        slot: {
          id: slot.id,
          date: slot.date,
          time: `${slot.start_time.slice(0, 5)}-${slot.end_time.slice(0, 5)}`,
          capacity_left: 0,
        },
      };
    }

    // Book the slot (set is_booked = true, reduce capacity)
    const { data: updated, error: updateError } = await db
      .from("availability_slots")
      .update({
        is_booked: true,
        capacity: slot.capacity - 1,
      })
      .eq("id", slotId)
      .select()
      .single();

    if (updateError) {
      return { error: "Failed to book slot: " + updateError.message };
    }

    return {
      success: true,
      booking: {
        slot_id: updated.id,
        date: updated.date,
        time: `${updated.start_time.slice(0, 5)}-${updated.end_time.slice(0, 5)}`,
        status: "booked",
        capacity_left: updated.capacity,
      },
    };
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
      tax_applicable,
      sort_by = "name",
      sort_order = "asc",
      page = 1,
      limit = 10,
    } = params;

    let query = db.from("items").select("*");

    if (active_only === true || active_only === "true") {
      query = query.eq("is_active", true);
    }

    if (search) {
      query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%`);
    }

    if (subcategory_id) {
      query = query.eq("subcategory_id", subcategory_id);
    } else if (category_id) {
      query = query.eq("category_id", category_id).is("subcategory_id", null);
    }

    const validSortFields = ["name", "created_at"];
    const sortField = validSortFields.includes(sort_by) ? sort_by : "name";
    const ascending = sort_order === "asc";
    query = query.order(sortField, { ascending });

    // Don't paginate yet - we need to filter first
    const { data: items, error } = await query;

    if (error) {
      return { error: error.message };
    }

    let filteredItems = items || [];

    if (filteredItems.length > 0) {
      const itemsWithSubcategory = filteredItems.filter(
        (item) => item.subcategory_id
      );
      const itemsWithCategory = filteredItems.filter(
        (item) => item.category_id && !item.subcategory_id
      );

      let validItems = [];

      if (itemsWithSubcategory.length > 0) {
        const subcategoryIds = [
          ...new Set(itemsWithSubcategory.map((item) => item.subcategory_id)),
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

        validItems = validItems.concat(
          itemsWithSubcategory.filter((item) =>
            validSubcategoryIds.has(item.subcategory_id)
          )
        );
      }

      if (itemsWithCategory.length > 0) {
        const categoryIds = [
          ...new Set(itemsWithCategory.map((item) => item.category_id)),
        ];

        const { data: categories } = await db
          .from("categories")
          .select("id, is_active")
          .in("id", categoryIds);

        const activeCategoryIds = new Set(
          categories?.filter((c) => c.is_active).map((c) => c.id) || []
        );

        validItems = validItems.concat(
          itemsWithCategory.filter((item) =>
            activeCategoryIds.has(item.category_id)
          )
        );
      }

      filteredItems = validItems;
    }

    // Filter by price range
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

    // Filter by tax_applicable (if specified)
    if (tax_applicable !== undefined) {
      const taxFilter = tax_applicable === "true" || tax_applicable === true;
      
      // Filter items based on their tax status
      const itemsWithTaxInfo = await Promise.all(
        filteredItems.map(async (item) => {
          const tax = await this.getEffectiveTax(item.id);
          return {
            ...item,
            has_tax: tax.tax_applicable,
          };
        })
      );

      filteredItems = itemsWithTaxInfo.filter(
        (item) => item.has_tax === taxFilter
      );
    }

    // Now paginate the filtered results
    const from = (page - 1) * limit;
    const to = from + limit;
    const paginatedItems = filteredItems.slice(from, to);

    const formattedItems = paginatedItems.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      image: item.image,
      pricing_type: item.pricing_type,
      base_price: item.pricing_rules?.base_price || null,
      category_id: item.category_id || null,
      subcategory_id: item.subcategory_id || null,
      is_active: item.is_active,
      created_at: item.created_at,
    }));

    return {
      data: formattedItems,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: filteredItems.length,
        has_more: to < filteredItems.length,
      },
    };
  },
};

module.exports = Item;
