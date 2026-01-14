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
};

module.exports = Item;
