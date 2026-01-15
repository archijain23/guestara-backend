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

  // ADD after getEffectiveTax
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
      base_price: basePrice.toFixed(2), // "2000.00"
      subtotal: subtotal.toFixed(2), // "2000.00"
      tax_applicable: tax.tax_applicable,
      tax_percentage: tax.tax_percentage,
      tax_amount: taxAmount.toFixed(2), // "110.00"
      final_price: finalPrice.toFixed(2), // "2110.00"
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

    // Transform for frontend
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
      price: addon.price.toFixed(2), // "500.00"
      max_quantity: addon.max_quantity,
    }));
  },
  async searchItems(params = {}) {
    const {
      search,
      min_price,
      max_price,
      subcategory_id,
      page = 1,
      limit = 10,
    } = params;

    let query = `
    SELECT id, name, description, image, pricing_type, pricing_rules, subcategory_id, created_at
    FROM items 
    WHERE is_active = true
  `;

    const conditions = [];
    const paramsArray = [];
    let paramIndex = 1;

    if (search) {
      conditions.push(
        `name ILIKE $${paramIndex} OR description ILIKE $${paramIndex + 1}`
      );
      paramsArray.push(`%${search}%`, `%${search}%`);
      paramIndex += 2;
    }

    if (subcategory_id) {
      conditions.push(`subcategory_id = $${paramIndex}`);
      paramsArray.push(subcategory_id);
      paramIndex += 1;
    }

    if (min_price || max_price) {
      conditions.push(
        `(pricing_rules->>'base_price')::numeric BETWEEN COALESCE($${paramIndex}, 0) AND COALESCE($${
          paramIndex + 1
        }, 999999)`
      );
      paramsArray.push(min_price || null, max_price || null);
      paramIndex += 2;
    }

    if (conditions.length) query += " AND " + conditions.join(" AND ");

    query += ` ORDER BY name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    paramsArray.push(limit, (page - 1) * limit);

    const { data: items, error } = await db.rpc("execute_sql", {
      sql: query,
      params: paramsArray,
    });

    if (error) return { error: error.message };

    // Simple count (no pagination info for now)
    return { items };
  },
};

module.exports = Item;
