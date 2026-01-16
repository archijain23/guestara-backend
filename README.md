Guestara Restaurant Menu Backend

A backend API for managing restaurant menus with flexible pricing, tax inheritance, and all the good stuff you'd expect from a modern menu system.

Table of Contents
- How This Thing Works
- Database Design
- The Tax System
- Pricing Engine
- What I Didn't Build (And Why)
- Getting Started
- API Endpoints
- Reflections

---

How This Thing Works

Project Structure

src/
  app.js - Main Express app with all the routes
  config/
    db.js - Supabase connection setup
  models/
    restaurant.js - Restaurant operations
    category.js - Category management
    subcategory.js - Subcategory with tax stuff
    item.js - Items with all the pricing magic


The Big Picture

I went with a model-based setup where each database table gets its own model file. Think of it like:
- Routes handle HTTP stuff (requests, responses)
- Models handle business logic (pricing, tax calculations, data validation)

The data flows in a hierarchy:

Restaurant → Category → Subcategory → Item

Why this way? A few reasons:
- Easy to debug: When pricing breaks, I know exactly where to look (item.js)
- Easy to test: Each model can be tested independently
- Easy to change: Want to swap Supabase for PostgreSQL? Just change db.js
- Clean code: Route handlers stay small and readable

---

Database Design

The Tables

Here's how I structured the database:

Restaurants - The top level

id, name, location, created_at

Pretty straightforward. Everything starts here.

Categories - Big groupings like "Beverages" or "Food"

id, restaurant_id, name, tax_applicable, tax_percentage, is_active, created_at

I added tax fields here because restaurants usually have tax policies that apply to entire categories (like "all alcohol is 18% tax").

Subcategories - Smaller groups under categories

id, parent_id, name, tax_applicable, tax_percentage, is_active, created_at

These can override the parent category's tax. More on that below.

Items - The actual menu items

id, subcategory_id, name, description, image, pricing_type, pricing_rules (JSONB), is_active, created_at

The interesting bit is pricing_rules being JSONB. I did this because different pricing types need different data:
- Static pricing just needs a base price
- Tiered pricing needs multiple price tiers
- Discounted pricing needs discount type and value
- Dynamic pricing needs time windows

Using JSONB means I don't need separate tables for each pricing type, and PostgreSQL can still index and query this data efficiently.

Availability Slots - For bookable items

id, item_id, date, start_time, end_time, capacity, is_booked, created_at

Item Add-ons - Extra stuff customers can add

id, item_id, name, description, price, max_quantity, is_active, created_at

Design Choices Worth Mentioning

Why is_active instead of deleting?
When you delete a menu item, you lose history. What if someone ordered it yesterday? With is_active, I can hide items from customers but keep the data for reports and order history.

Why separate add-ons table?
Originally thought about embedding add-ons in the items table, but a separate table means:
- Multiple items can share the same add-on
- Add-ons can be managed independently
- Better database normalization

Why JSONB for pricing?
Honestly, this was the trickiest decision. The alternatives were:
1. Separate table for each pricing type (too many tables)
2. One huge table with all possible fields (mostly nulls, confusing)
3. JSONB (flexible, but needs validation in code)

I went with JSONB because the assignment emphasized different pricing models, and this makes adding new types way easier.

---

The Tax System

How Tax Inheritance Works

Items don't store their own tax rate. Instead, they inherit it:

Item → checks Subcategory → falls back to Category → no tax

Here's the actual logic from item.js:

1. Get the item's subcategory
2. Does the subcategory have tax enabled? Use it.
3. If not, check the parent category's tax
4. Still nothing? No tax applies (0%)

The response tells you where the tax came from:

{
  "tax_applicable": true,
  "tax_percentage": 12,
  "inherited_from": "subcategory"
}

Real Examples

Example 1: Basic inheritance
- Item: "Cappuccino"
- Subcategory: "Hot Drinks" (no tax set)
- Category: "Beverages" (5% tax)
- Result: 5% tax from category

Example 2: Subcategory override
- Item: "Craft Beer"
- Subcategory: "Premium Alcohol" (12% tax)
- Category: "Beverages" (5% tax)
- Result: 12% tax from subcategory (overrides category)

Example 3: No tax
- Item: "Water Bottle"
- Subcategory: "Essentials" (no tax)
- Category: "Basics" (no tax)
- Result: 0% tax

Why This Approach?

I could have denormalized and stored tax on every item, but inheritance makes more sense because:
- If a category's tax changes (government updates tax law), all items update automatically
- Less data redundancy
- Reflects how restaurants actually think about taxes ("all desserts are taxed at X%")

The downside is it requires joins, but that's a worthwhile tradeoff for maintainability.

---

Pricing Engine

This was the fun part. The system supports 5 different pricing models:

1. Static Pricing

What it is: Normal fixed prices
Example: "Caesar Salad - Rs.299"

{
  "pricing_type": "static",
  "pricing_rules": {
    "base_price": 299
  }
}

2. Tiered Pricing

What it is: Price changes based on duration
Example: "Banquet Hall - Rs.5000 for 3hrs, Rs.8000 for 6hrs"

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

When you request the price, you pass duration_hours=4, and it finds the first tier where 4 <= max_hours.

3. Complimentary Pricing

What it is: Free stuff
Example: "Welcome Drink - Free"

{
  "pricing_type": "complimentary",
  "pricing_rules": {}
}

Always returns Rs.0. Simple.

4. Discounted Pricing

What it is: Items on sale
Example: "Seasonal Special - Was Rs.1000, now 20% off"

{
  "pricing_type": "discounted",
  "pricing_rules": {
    "base_price": 1000,
    "discount_type": "percentage",
    "discount_value": 20
  }
}

Supports both flat (Rs.50 off) and percentage (20% off) discounts. I added a safety check to make sure the discount never exceeds the base price.

5. Dynamic Pricing

What it is: Different prices at different times
Example: "Happy Hour Beer - Rs.199 (6pm-8pm), normally Rs.299"

{
  "pricing_type": "dynamic",
  "pricing_rules": {
    "base_price": 299,
    "time_windows": [
      { "start_time": "18:00", "end_time": "20:00", "price": 199 }
    ]
  }
}

If you request the price outside the time window, you get an error saying the item isn't available right now.

How Price Calculation Works

The flow is:

1. Figure out base price based on pricing type
2. Apply discounts (if it's a discounted item)
3. Calculate subtotal = base price - discount
4. Get the tax rate using inheritance
5. Calculate tax amount = subtotal × tax percentage
6. Final price = subtotal + tax

The API returns a full breakdown:

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

---

What I Didn't Build (And Why)

What's In There

Full CRUD for restaurants, categories, subcategories, items
All 5 pricing types working
Tax inheritance with proper fallback
Pagination on list endpoints
Availability checking
Add-ons system
Search with filters
Active/inactive management

What I Skipped

No authentication
The assignment focused on data modeling and business logic, so I left out auth. In a real app, I'd add JWT tokens and role-based permissions (admin vs staff vs public).

Minimal validation
I validate pricing types and check for required fields, but I didn't go full Joi/Zod schema validation. Kept it simple to focus on the core functionality.

No caching
Every request hits the database. For a demo with Supabase, this is fine. At scale, I'd add Redis to cache frequently accessed categories and items.

No transaction management
Right now, if you create an item with add-ons, they're separate database calls. In production, I'd wrap these in transactions for atomicity.

Basic error handling
Errors are just { error: "message" }. A real API would have error codes, detailed messages, and proper HTTP status codes.

Simplified availability
The availability system tracks slots but doesn't handle actual booking logic, conflict resolution, or waitlists. Just wanted to show the concept.

No read replicas or connection pooling
Single database instance. At high traffic, you'd want read replicas for GET requests and proper connection pooling.

Why These Choices Made Sense

The assignment was about demonstrating:
- Clean architecture
- Complex business logic (pricing, taxes)
- Data modeling skills
- Clear thinking

Adding authentication, caching, and comprehensive validation would've:
- Taken focus away from the core requirements
- Made the code harder to review quickly
- Not really shown any new skills

So I optimized for clarity and demonstrating the interesting parts.

---

Getting Started

What You Need
- Node.js (v16 or higher)
- A Supabase account (free tier works great)
- 10 minutes

Installation

1. Clone it

git clone https://github.com/archijain23/guestara-backend.git
cd guestara-backend

2. Install dependencies

npm install

3. Set up environment variables

Create a .env file:

SUPABASE_URL=your_project_url
SUPABASE_ANON_KEY=your_anon_key
PORT=3000

Get these from your Supabase project settings → API section.

4. Create the database tables

Go to your Supabase SQL Editor and run:

CREATE TABLE restaurants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  location TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id),
  name TEXT NOT NULL,
  tax_applicable BOOLEAN DEFAULT false,
  tax_percentage DECIMAL(5,2) DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE subcategories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID REFERENCES categories(id),
  name TEXT NOT NULL,
  tax_applicable BOOLEAN DEFAULT false,
  tax_percentage DECIMAL(5,2) DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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

5. Start the server

node src/app.js

You should see: Server on 3000

6. Test it

curl http://localhost:3000/health

If you get {"status":"OK","connected":true}, you're good to go.

---

API Endpoints

Restaurants

Create a restaurant

curl -X POST http://localhost:3000/restaurants \
  -H "Content-Type: application/json" \
  -d '{"name": "The Grand Bistro", "location": "Mumbai"}'

List restaurants

curl http://localhost:3000/restaurants?page=1&limit=10

Categories

Create a category

curl -X POST http://localhost:3000/categories \
  -H "Content-Type: application/json" \
  -d '{
    "restaurant_id": "your-restaurant-uuid",
    "name": "Beverages",
    "tax_applicable": true,
    "tax_percentage": 5
  }'

Get categories

curl http://localhost:3000/categories?restaurant_id=your-uuid

Items

Create an item with static pricing

curl -X POST http://localhost:3000/items \
  -H "Content-Type: application/json" \
  -d '{
    "subcategory_id": "your-subcategory-uuid",
    "name": "Cappuccino",
    "description": "Classic Italian coffee",
    "pricing_type": "static",
    "pricing_rules": {"base_price": 250}
  }'

Get item price

curl http://localhost:3000/items/{item-id}/price

For tiered pricing:

curl http://localhost:3000/items/{item-id}/price?duration_hours=3

Check availability

curl http://localhost:3000/items/{item-id}/availability?date=2026-01-20

Get add-ons

curl http://localhost:3000/items/{item-id}/addons

Search items

curl "http://localhost:3000/items/search?search=coffee&min_price=100&max_price=500"

---

Reflections

Why PostgreSQL?

I picked PostgreSQL (via Supabase) for a few reasons:

JSONB is perfect for this
The different pricing types needed flexible data structures. MongoDB would've worked too, but I wanted the safety of relational foreign keys for the restaurant → category → subcategory → item hierarchy. PostgreSQL's JSONB gave me the best of both worlds.

The tax inheritance needed joins
Doing that in MongoDB would mean multiple queries or embedding everything (which gets messy when categories change).

Supabase is convenient
Real-time subscriptions, built-in auth (for future), auto-generated API (though I built custom endpoints), and a generous free tier. It's basically Postgres with batteries included.

Alternative I considered
MongoDB for the nested documents, but rejected it because maintaining referential integrity would be a pain. Plus, doing complex queries across collections isn't as clean as SQL joins.

Three Things I Learned

1. JSONB needs discipline
Storing flexible data in JSONB is great until you realize you have no schema enforcement at the database level. I had to be really careful with validation in the model layer. For example, making sure tiered pricing always has a tiers array, and discounted pricing has both discount_type and discount_value.

The lesson: flexibility is powerful but requires strict application-level validation.

2. Tax inheritance is more nuanced than it seems
Initially thought "just check if parent has tax" but then ran into questions:
- What if subcategory is inactive but category is active?
- Should I cache tax calculations or compute on-the-fly?
- How do I make it clear to API users where the tax came from?

I ended up adding the inherited_from field to the response, which made debugging way easier.

3. Pagination + filtering = tricky
When you paginate in the database (LIMIT/OFFSET) but then filter in application code (checking if parent is active), your page counts get weird. Page 1 might return 10 items, but Page 2 might return 3 because 7 were filtered out.

I chose to filter in the app for code clarity, accepting the tradeoff. The proper fix would be complex SQL with CTEs, which felt like over-engineering for a demo.

Hardest Challenge

Making dynamic pricing actually useful

The assignment said "implement dynamic pricing" but left the details vague (intentionally, I think). I had to decide:

- What if time windows overlap? (decided: first match wins)
- What if current time doesn't match any window? (decided: return error, don't silently use base price)
- How to handle timezone differences? (decided: assume everything is local time, HH:MM format)
- Should windows cross midnight? (decided: yes, but didn't fully implement)

The hard part wasn't the code—it was making design decisions without clear requirements. I ended up choosing the simplest approach that would be extensible later (storing time windows as an array means I can add day-of-week or date-specific pricing without schema changes).

What I learned: when specs are ambiguous, pick something reasonable, document your assumptions, and design for future changes.

What I'd Improve With More Time

Testing
Zero tests right now. I'd add:
- Unit tests for each pricing type (especially edge cases like midnight crossovers)
- Integration tests for tax inheritance
- API tests with Supertest
- Property-based testing for pricing calculations

Better query optimization
The list() methods have N+1 queries when checking parent active status. I'd rewrite those with proper JOINs and add database indexes on foreign keys and is_active columns.

Transaction support
Right now, creating an item with add-ons is two separate database calls. If one fails, you get partial data. I'd wrap these in transactions.

Refactor the pricing engine
The calculatePrice() function is 200+ lines. I'd extract each pricing type into its own function or use a strategy pattern:

const strategies = {
  static: (item) => item.pricing_rules.base_price,
  tiered: (item, params) => calculateTiered(item, params),
  ...
};

const price = strategies[item.pricing_type](item, params);

Proper validation
Right now it's scattered. I'd add Zod schemas for each endpoint and centralize validation in middleware.

API documentation
Generate Swagger/OpenAPI docs automatically so frontend devs can see what's available.

Audit logging
Track who changed what and when. Especially important for price changes.

Better error responses
Instead of {error: "message"}, return structured errors with codes:

{
  "error": {
    "code": "INVALID_PRICING_TYPE",
    "message": "Pricing type 'xyz' is not supported",
    "supported_types": ["static", "tiered", ...]
  }
}

---

Final Thoughts

This was a fun project. The core challenge wasn't building CRUD endpoints—it was designing a system that handles:
- Multiple pricing models without turning into spaghetti code
- Tax inheritance that actually makes sense
- A flexible schema that can evolve without breaking things

I tried to balance "good enough to demonstrate thinking" with "not over-engineered." Hope this README shows that I can both write code and explain why I made the choices I did.

---

Built by Archi Jain
GitHub: @archijain23
Email: jainarchi023@gmail.com
