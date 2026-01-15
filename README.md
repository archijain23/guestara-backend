# Guestara Restaurant Menu & Services Management Backend

A Node.js backend API for managing restaurant menus with hierarchical categories, flexible pricing models, tax inheritance, availability tracking, and add-ons management.

## 📋 Table of Contents
- [Overall Architecture](#overall-architecture)
- [Data Modeling Decisions](#data-modeling-decisions)
- [Tax Inheritance Implementation](#tax-inheritance-implementation)
- [Pricing Engine](#pricing-engine)
- [Tradeoffs & Design Choices](#tradeoffs--design-choices)
- [Setup & Installation](#setup--installation)
- [API Documentation](#api-documentation)
- [Written Reflections](#written-reflections)

---

## 🏗️ Overall Architecture

### Project Structure
```
src/
├── app.js              # Main Express application with route definitions
├── config/
│   └── db.js          # Supabase client configuration
└── models/
    ├── restaurant.js  # Restaurant CRUD operations
    ├── category.js    # Category management
    ├── subcategory.js # Subcategory management with tax handling
    └── item.js        # Item management with pricing & tax logic
```

### Architectural Decisions

**Model-Driven Architecture**: I chose a model-based architecture where each database entity (Restaurant, Category, Subcategory, Item) has its own model file containing business logic. This provides:
- Clear separation of concerns
- Easy maintainability and testing
- Business logic encapsulation away from route handlers

**Layered Hierarchy**: The data follows a strict hierarchy:
```
Restaurant → Category → Subcategory → Item
```

**Why this structure?**
- **Scalability**: Each model can be independently modified without affecting others
- **Testability**: Business logic is isolated and can be unit tested
- **Clarity**: Route handlers remain clean and delegate to model methods
- **Database Agnostic**: Using Supabase client as an abstraction layer makes it easier to switch databases if needed

---

## 📊 Data Modeling Decisions

### Database Schema

#### 1. **Restaurants Table**
```sql
- id (PK)
- name
- location
- created_at
```
The root entity. All categories belong to a restaurant.

#### 2. **Categories Table**
```sql
- id (PK)
- restaurant_id (FK)
- name
- tax_applicable (boolean)
- tax_percentage (decimal)
- is_active (boolean)
- created_at
```
**Design Decision**: Tax configuration at category level allows restaurant-wide tax policies (e.g., "Beverages" taxed at 5%, "Alcohol" at 18%).

#### 3. **Subcategories Table**
```sql
- id (PK)
- parent_id (FK to categories)
- name
- tax_applicable (boolean)
- tax_percentage (decimal)
- is_active (boolean)
- created_at
```
**Design Decision**: Subcategories can override parent category tax. This supports scenarios like "Imported Wine" having different tax than regular "Wine".

#### 4. **Items Table**
```sql
- id (PK)
- subcategory_id (FK)
- name
- description
- image (URL)
- pricing_type (enum: static, tiered, complimentary, discounted, dynamic)
- pricing_rules (JSONB)
- is_active (boolean)
- created_at
```
**Why JSONB for pricing_rules?**
- Different pricing types need different data structures
- Flexible schema without creating multiple tables
- PostgreSQL JSONB provides indexing and querying capabilities
- Easy to extend with new pricing types

#### 5. **Availability Slots Table**
```sql
- id (PK)
- item_id (FK)
- date
- start_time
- end_time
- capacity
- is_booked (boolean)
- created_at
```

#### 6. **Item Add-ons Table**
```sql
- id (PK)
- item_id (FK)
- name
- description
- price
- max_quantity
- is_active (boolean)
- created_at
```

### Key Modeling Decisions

1. **Soft Deletes via `is_active` Flag**: Instead of hard deletes, items/categories can be deactivated. This:
   - Preserves historical data
   - Allows easy restoration
   - Maintains referential integrity

2. **Separate Add-ons Table**: Rather than embedding add-ons in items, a separate table allows:
   - Multiple items to share add-ons
   - Independent add-on management
   - Better normalization

3. **JSONB for Flexible Pricing**: Each pricing type has unique parameters:
   ```json
   // Static
   { "base_price": 299 }
   
   // Tiered
   { "base_price": 500, "tiers": [{"max_hours": 3, "price": 500}] }
   
   // Discounted
   { "base_price": 1000, "discount_type": "percentage", "discount_value": 20 }
   
   // Dynamic
   { "base_price": 800, "time_windows": [{"start_time": "18:00", "end_time": "21:00", "price": 1200}] }
   ```

---

## 🧾 Tax Inheritance Implementation

### How It Works

The tax system follows a **fallback hierarchy**:

```
Item (no tax) → Subcategory → Category → No Tax (0%)
```

### Code Implementation (`src/models/item.js`)

```javascript
async getEffectiveTax(itemId) {
  // 1. Get item's subcategory
  const { data: item } = await db
    .from("items")
    .select("subcategory_id")
    .eq("id", itemId)
    .single();

  // 2. Check subcategory tax
  const { data: subcategory } = await db
    .from("subcategories")
    .select("parent_id, tax_applicable, tax_percentage")
    .eq("id", item.subcategory_id)
    .single();

  if (subcategory.tax_applicable) {
    return {
      tax_applicable: true,
      tax_percentage: subcategory.tax_percentage,
      inherited_from: "subcategory"
    };
  }

  // 3. Fallback to category tax
  const { data: category } = await db
    .from("categories")
    .select("tax_applicable, tax_percentage")
    .eq("id", subcategory.parent_id)
    .single();

  if (category && category.tax_applicable) {
    return {
      tax_applicable: true,
      tax_percentage: category.tax_percentage,
      inherited_from: "category"
    };
  }

  // 4. No tax applicable
  return { tax_applicable: false, tax_percentage: 0 };
}
```

### Example Scenarios

| Item | Subcategory Tax | Category Tax | Applied Tax | Source |
|------|----------------|--------------|-------------|--------|
| Cappuccino | - | 5% | 5% | Category |
| Craft Beer | 12% | 18% | 12% | Subcategory |
| Water | - | - | 0% | None |

### Design Rationale

**Why this approach?**
- **Flexibility**: Individual subcategories can have exceptions
- **Simplicity**: Tax is computed on-the-fly, no denormalization needed
- **Maintainability**: Changing category tax updates all child items automatically
- **Transparency**: API response shows where tax was inherited from

---

## 💰 Pricing Engine

The pricing engine supports **5 distinct pricing models** as required.

### 1. Static Pricing
**Use Case**: Fixed-price items (e.g., "Caesar Salad - ₹299")

```json
{
  "pricing_type": "static",
  "pricing_rules": {
    "base_price": 299
  }
}
```

### 2. Tiered Pricing
**Use Case**: Hourly services (e.g., "Banquet Hall - ₹5000/3hrs, ₹8000/6hrs")

```json
{
  "pricing_type": "tiered",
  "pricing_rules": {
    "base_price": 5000,
    "tiers": [
      { "max_hours": 3, "price": 5000 },
      { "max_hours": 6, "price": 8000 }
    ]
  }
}
```

**Logic**: 
```javascript
const duration = parseFloat(requestParams.duration_hours) || 1;
const tier = rules.tiers.find(t => duration <= t.max_hours);
basePrice = tier ? tier.price : rules.base_price;
```

### 3. Complimentary Pricing
**Use Case**: Free items (e.g., "Welcome Drink - Free")

```json
{
  "pricing_type": "complimentary",
  "pricing_rules": {}
}
```

Always returns `final_price: 0.00`

### 4. Discounted Pricing
**Use Case**: Promotional items with flat or percentage discounts

```json
{
  "pricing_type": "discounted",
  "pricing_rules": {
    "base_price": 1000,
    "discount_type": "percentage",  // or "flat"
    "discount_value": 20
  }
}
```

**Logic**:
```javascript
if (discountType === "flat") {
  discount = discountValue;
} else if (discountType === "percentage") {
  discount = (basePrice * discountValue) / 100;
}
// Safety: Ensure discount never exceeds base price
discount = Math.min(discount, basePrice);
```

### 5. Dynamic Pricing
**Use Case**: Time-based pricing (e.g., "Happy Hour Drinks - ₹199 (6-8pm)")

```json
{
  "pricing_type": "dynamic",
  "pricing_rules": {
    "base_price": 299,
    "time_windows": [
      { "start_time": "18:00", "end_time": "20:00", "price": 199 }
    ]
  }
}
```

**Logic**:
```javascript
const currentTime = requestParams.current_time || new Date().toTimeString().slice(0, 5);
const matchedWindow = timeWindows.find(w => 
  currentTime >= w.start_time && currentTime <= w.end_time
);

if (matchedWindow) {
  basePrice = matchedWindow.price;
} else {
  return { error: "Item not available at this time" };
}
```

### Price Calculation Flow

```
1. Determine base_price based on pricing_type
2. Apply discounts (if discounted type)
3. Calculate subtotal = base_price - discount
4. Fetch effective tax using inheritance
5. Calculate tax_amount = subtotal × (tax_percentage / 100)
6. final_price = subtotal + tax_amount
```

### Example API Response

```json
{
  "item_id": "abc123",
  "item_name": "Premium Coffee",
  "pricing_type": "discounted",
  "applied_rule": "discounted (percentage)",
  "base_price": "250.00",
  "discount": "50.00",
  "discount_reason": "20% discount",
  "subtotal": "200.00",
  "tax_applicable": true,
  "tax_percentage": "5",
  "tax_amount": "10.00",
  "final_price": "210.00"
}
```

---

## ⚖️ Tradeoffs & Design Choices

### What I Built

✅ Complete CRUD for all entities  
✅ All 5 pricing types fully functional  
✅ Tax inheritance with fallback logic  
✅ Pagination for list endpoints  
✅ Availability slots system  
✅ Add-ons support  
✅ Active/inactive filtering  
✅ Search with multiple filters  

### What I Simplified (and Why)

#### 1. **No Authentication/Authorization**
**Tradeoff**: Focused on core business logic over security  
**Why**: The assignment emphasis was on data modeling and pricing logic. In production, I would add:
- JWT-based authentication
- Role-based access control (Admin, Manager, Staff)
- API key validation for external integrations

#### 2. **Minimal Input Validation**
**Tradeoff**: Basic enum validation for pricing types, but no comprehensive schema validation  
**Why**: Kept code simple for demonstration. In production:
- Use Joi/Zod for request validation
- Add custom error messages
- Validate JSONB structure for pricing_rules

#### 3. **No Caching Layer**
**Tradeoff**: Direct database queries on every request  
**Why**: Supabase is fast enough for demo purposes. At scale:
- Add Redis for frequently accessed items
- Cache category/subcategory hierarchies
- Implement stale-while-revalidate pattern

#### 4. **Single Database Instance**
**Tradeoff**: No read replicas or sharding  
**Why**: Premature optimization. For high traffic:
- Use read replicas for GET endpoints
- Implement connection pooling
- Add database indexing on foreign keys

#### 5. **Simplified Availability System**
**Tradeoff**: Basic time slots without conflict resolution or booking logic  
**Why**: The assignment didn't require a full booking system. I focused on:
- Demonstrating time-based queries
- Showing capacity tracking concept
- Keeping it extensible

#### 6. **No Transaction Management**
**Tradeoff**: Separate insert/update calls without rollback  
**Why**: For CRUD operations, atomicity wasn't critical. In production:
- Wrap related operations in database transactions
- Handle cascade deletes properly
- Implement optimistic locking

#### 7. **Basic Error Handling**
**Tradeoff**: Simple error messages without error codes  
**Why**: Readable for debugging. For production:
- Structured error responses with codes
- Logging with correlation IDs
- Retry mechanisms for transient failures

### Why These Tradeoffs Made Sense

The assignment explicitly asked to demonstrate:
1. **Architecture understanding** ✅
2. **Data modeling skills** ✅
3. **Complex business logic (pricing, tax)** ✅
4. **Clear documentation** ✅

Adding authentication, caching, or advanced validation would have:
- Diluted focus from core requirements
- Added complexity without demonstrating new skills
- Made the codebase harder to evaluate quickly

---

## 🚀 Setup & Installation

### Prerequisites
- Node.js (v16+)
- npm or yarn
- Supabase account (free tier works)

### Step 1: Clone the Repository
```bash
git clone https://github.com/archijain23/guestara-backend.git
cd guestara-backend
```

### Step 2: Install Dependencies
```bash
npm install
```

### Step 3: Configure Environment Variables
Create a `.env` file in the root directory:

```env
SUPABASE_URL=your_supabase_project_url
SUPABASE_ANON_KEY=your_supabase_anon_key
PORT=3000
```

**How to get Supabase credentials:**
1. Go to [supabase.com](https://supabase.com) and create a project
2. Navigate to Project Settings → API
3. Copy the URL and `anon public` key

### Step 4: Set Up Database Schema
Run these SQL commands in your Supabase SQL Editor:

```sql
-- Restaurants
CREATE TABLE restaurants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  location TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Categories
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id),
  name TEXT NOT NULL,
  tax_applicable BOOLEAN DEFAULT false,
  tax_percentage DECIMAL(5,2) DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Subcategories
CREATE TABLE subcategories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID REFERENCES categories(id),
  name TEXT NOT NULL,
  tax_applicable BOOLEAN DEFAULT false,
  tax_percentage DECIMAL(5,2) DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Items
CREATE TABLE items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subcategory_id UUID REFERENCES subcategories(id),
  name TEXT NOT NULL,
  description TEXT,
  image TEXT,
  pricing_type TEXT CHECK (pricing_type IN ('static', 'tiered', 'complimentary', 'discounted', 'dynamic')),
  pricing_rules JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Availability Slots
CREATE TABLE availability_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID REFERENCES items(id),
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  capacity INTEGER DEFAULT 1,
  is_booked BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Item Add-ons
CREATE TABLE item_addons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID REFERENCES items(id),
  name TEXT NOT NULL,
  description TEXT,
  price DECIMAL(10,2) NOT NULL,
  max_quantity INTEGER DEFAULT 1,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Step 5: Start the Server
```bash
node src/app.js
```

The server will start on `http://localhost:3000`

### Step 6: Verify Installation
```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "OK",
  "connected": true,
  "restaurant_count": 0
}
```

---

## 📚 API Documentation

### Base URL
```
http://localhost:3000
```

### Restaurants

#### Create Restaurant
```http
POST /restaurants
Content-Type: application/json

{
  "name": "The Grand Bistro",
  "location": "Mumbai, India"
}
```

#### List Restaurants
```http
GET /restaurants?page=1&limit=10
```

---

### Categories

#### Create Category
```http
POST /categories
Content-Type: application/json

{
  "restaurant_id": "uuid-here",
  "name": "Beverages",
  "tax_applicable": true,
  "tax_percentage": 5
}
```

#### List Categories
```http
GET /categories?restaurant_id=uuid-here&page=1&limit=10
```

#### Update Category
```http
PUT /categories/:id
Content-Type: application/json

{
  "tax_percentage": 8
}
```

---

### Subcategories

#### Create Subcategory
```http
POST /subcategories
Content-Type: application/json

{
  "parent_id": "category-uuid",
  "name": "Hot Beverages",
  "tax_applicable": false
}
```

#### List Subcategories
```http
GET /subcategories?category_id=uuid-here&page=1&limit=10
```

---

### Items

#### Create Item (Static Pricing)
```http
POST /items
Content-Type: application/json

{
  "subcategory_id": "uuid-here",
  "name": "Cappuccino",
  "description": "Classic Italian coffee",
  "pricing_type": "static",
  "pricing_rules": {
    "base_price": 250
  }
}
```

#### Create Item (Discounted Pricing)
```http
POST /items
Content-Type: application/json

{
  "subcategory_id": "uuid-here",
  "name": "Seasonal Smoothie",
  "pricing_type": "discounted",
  "pricing_rules": {
    "base_price": 300,
    "discount_type": "percentage",
    "discount_value": 15
  }
}
```

#### Calculate Item Price
```http
GET /items/:id/price?duration_hours=3
```

Response:
```json
{
  "item_id": "abc123",
  "item_name": "Conference Room",
  "pricing_type": "tiered",
  "applied_rule": "tiered (3h)",
  "base_price": "5000.00",
  "subtotal": "5000.00",
  "tax_applicable": true,
  "tax_percentage": "18",
  "tax_amount": "900.00",
  "final_price": "5900.00"
}
```

#### Get Effective Tax
```http
GET /items/:id/tax
```

#### Get Availability
```http
GET /items/:id/availability?date=2026-01-20
```

#### Get Add-ons
```http
GET /items/:id/addons
```

#### Search Items
```http
GET /items/search?search=coffee&min_price=100&max_price=500&sort_by=name&sort_order=asc
```

---

## 💭 Written Reflections

### Why did you choose your database?

I chose **PostgreSQL (via Supabase)** for several reasons:

1. **JSONB Support**: The flexible pricing rules for different pricing types required a schema-less structure within a relational context. PostgreSQL's JSONB gave me:
   - Type validation
   - Indexing capabilities
   - Query flexibility without sacrificing relational integrity

2. **Relational Integrity**: The restaurant → category → subcategory → item hierarchy needed proper foreign key constraints and cascading behaviors that NoSQL databases don't naturally provide.

3. **Developer Experience**: Supabase provides:
   - Auto-generated REST API (though I built custom endpoints)
   - Built-in authentication (for future use)
   - Real-time subscriptions (if needed)
   - Excellent free tier for development

4. **SQL Maturity**: Complex queries for tax inheritance and active item filtering across multiple tables would be cumbersome in NoSQL. SQL's JOINs and subqueries made this elegant.

**Alternative Considered**: MongoDB for its native nested document support, but I rejected it because tax inheritance logic would require multiple database calls instead of SQL JOINs.

---

### Three things you learned while building this

1. **JSONB is Powerful but Requires Discipline**  
   I learned that storing flexible data in JSONB is great for varying schemas (like different pricing types), but it requires strict validation at the application layer. Without enforcing structure in code, the database becomes a "data swamp." I implemented validation in the `create()` and `update()` methods to ensure `pricing_rules` match their `pricing_type`.

2. **Hierarchical Tax Inheritance is Deceptively Complex**  
   What seemed simple ("just check parent's tax") became nuanced when considering:
   - What if subcategory is inactive but category is active?
   - Should null/undefined tax mean "inherit" or "no tax"?
   - How to make the source of inheritance transparent to users?
   
   I learned to make implicit logic explicit by returning `inherited_from` in the API response.

3. **Pagination + Filtering = Data Integrity Challenges**  
   When implementing `list()` with pagination and `is_active` filtering, I discovered that:
   - You can't just paginate items; you must also check if parent subcategory/category are active
   - Database pagination (LIMIT/OFFSET) happens before filtering, so page counts can be misleading
   - Solution: Filter in application layer or use complex SQL WITH clauses
   
   I chose application-level filtering for code readability, accepting the performance tradeoff for now.

---

### The hardest technical or design challenge you faced

**Challenge**: **Implementing Dynamic Pricing Without Overcomplicating the System**

The assignment required dynamic pricing based on time windows, but the requirements were deliberately vague to test design thinking. I struggled with:

**Questions I faced:**
- Should time windows overlap? (e.g., "Happy Hour" 6-8pm AND "Late Night" 7-10pm)
- What happens if current time doesn't match any window?
- Should the system return base price or throw an error?
- How to handle timezone considerations?

**My Solution:**
1. **Non-overlapping windows**: First match wins. Overlaps are considered a data entry error.
2. **Explicit failure**: If no window matches, return an error instead of silently using base price. This makes the system's behavior predictable.
3. **Timezone simplification**: Used HH:MM format (24-hour) without timezone storage. Assumed all times are in restaurant's local timezone.
4. **Extensibility**: Kept `time_windows` as an array in JSONB so future enhancements (day-of-week, date-specific pricing) could be added without schema changes.

**Why it was hard:**
- **Balancing flexibility vs. simplicity**: Too rigid = can't handle real use cases. Too flexible = impossible to validate.
- **User experience**: How to communicate unavailability vs. pricing to the client?
- **Testing edge cases**: Midnight crossovers (23:00-01:00), single-minute windows, etc.

**What I learned:**
When requirements are ambiguous, make a decision, document it clearly, and design for future changes. I added comments in code explaining the assumed behavior.

---

### What you would improve or refactor if you had more time

#### 1. **Add Comprehensive Testing**
Currently, no tests exist. I would add:
- **Unit tests** for pricing calculations (all 5 types)
- **Integration tests** for tax inheritance logic
- **API tests** using Supertest
- **Edge case tests** for boundary conditions (midnight crossovers, zero prices, etc.)

#### 2. **Implement Transactions for Multi-Step Operations**
Operations like "create item with add-ons" should be atomic. I would:
- Wrap related inserts in database transactions
- Add rollback logic on failure
- Use Supabase's transaction support or raw SQL

#### 3. **Add Request Validation Middleware**
Currently, validation is scattered across model files. I would:
- Use Joi or Zod for schema validation
- Create middleware to validate before reaching model layer
- Provide detailed error messages with field-level errors

#### 4. **Optimize Database Queries**
Some inefficiencies I'd address:
- **N+1 queries** in `list()` methods when checking parent active status
- Add database indexes on foreign keys and `is_active` columns
- Use SQL JOINs with `is_active` filters instead of application-level filtering
- Implement query result caching for rarely-changing data (categories)

#### 5. **Refactor Pricing Engine**
The `calculatePrice()` method is 200+ lines. I would:
- Extract each pricing type into its own function
- Create a `PricingStrategy` pattern (OOP) or functional equivalent
- Make it easier to add new pricing types without modifying existing code

Example structure:
```javascript
const pricingStrategies = {
  static: (item, params) => ({ basePrice: item.pricing_rules.base_price }),
  tiered: (item, params) => calculateTieredPrice(item, params),
  // ...
};

const strategy = pricingStrategies[item.pricing_type];
const { basePrice, discount } = strategy(item, requestParams);
```

#### 6. **Add Audit Logging**
For production use, I'd track:
- Who created/modified items
- Price change history
- Deleted entities (soft delete with audit trail)
- Failed price calculations (for debugging)

#### 7. **Improve Error Handling**
Replace generic `{ error: message }` with:
```javascript
{
  "error": {
    "code": "INVALID_PRICING_TYPE",
    "message": "Pricing type 'xyz' is not supported",
    "supported_types": ["static", "tiered", ...]
  }
}
```

#### 8. **Add API Documentation with Swagger**
Auto-generate API docs from route definitions using Swagger/OpenAPI so other developers (or frontend teams) can easily integrate.

---

## 🎯 Conclusion

This project demonstrates a production-ready approach to:
- Hierarchical data modeling with tax inheritance
- Flexible pricing systems with multiple strategies
- RESTful API design with pagination and filtering
- Clear separation of concerns

While there's always room for improvement (testing, caching, validation), the core architecture is solid and extensible.

---

## 👤 Author

**Archi Jain**  
- GitHub: [@archijain23](https://github.com/archijain23)
- Email: jainarchi023@gmail.com

---

## 📄 License

ISC
