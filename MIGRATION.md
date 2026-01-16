# Database Migration Guide

This guide explains how to update your existing Supabase database to support the new flexible item parent structure.

## What Changed?

Previously, items could only belong to subcategories:
- Restaurant → Category → Subcategory → Item (rigid)

Now, items can belong to either categories OR subcategories:
- Restaurant → Category → Item (direct)
- Restaurant → Category → Subcategory → Item (via subcategory)

## Migration Steps

### Step 1: Add category_id column to items table

Run this SQL in your Supabase SQL Editor:

```sql
-- Add the new category_id column
ALTER TABLE items 
ADD COLUMN category_id UUID REFERENCES categories(id);
```

### Step 2: Add constraint to ensure only one parent

This constraint ensures items belong to EITHER a category OR a subcategory, but not both:

```sql
-- Add check constraint
ALTER TABLE items 
ADD CONSTRAINT check_single_parent 
CHECK (
  (category_id IS NOT NULL AND subcategory_id IS NULL) OR
  (category_id IS NULL AND subcategory_id IS NOT NULL)
);
```

### Step 3: Make subcategory_id nullable (if not already)

Since items can now belong directly to categories, subcategory_id should be nullable:

```sql
-- Make subcategory_id nullable
ALTER TABLE items 
ALTER COLUMN subcategory_id DROP NOT NULL;
```

### Step 4: Verify the changes

Check that the constraint works:

```sql
-- This should work (item belongs to category only)
INSERT INTO items (name, category_id, pricing_type, pricing_rules)
VALUES ('Test Item', 'some-category-uuid', 'static', '{"base_price": 100}');

-- This should work (item belongs to subcategory only)
INSERT INTO items (name, subcategory_id, pricing_type, pricing_rules)
VALUES ('Test Item 2', 'some-subcategory-uuid', 'static', '{"base_price": 200}');

-- This should FAIL (item cannot belong to both)
INSERT INTO items (name, category_id, subcategory_id, pricing_type, pricing_rules)
VALUES ('Test Item 3', 'some-category-uuid', 'some-subcategory-uuid', 'static', '{"base_price": 300}');

-- This should FAIL (item must belong to at least one)
INSERT INTO items (name, pricing_type, pricing_rules)
VALUES ('Test Item 4', 'static', '{"base_price": 400}');
```

### Step 5: Update existing items (if needed)

If you have existing items that should belong directly to categories instead of subcategories:

```sql
-- Example: Move items from subcategory to parent category
UPDATE items 
SET 
  category_id = (SELECT parent_id FROM subcategories WHERE id = items.subcategory_id),
  subcategory_id = NULL
WHERE subcategory_id IN (
  -- List subcategory IDs you want to remove
  'subcategory-uuid-1',
  'subcategory-uuid-2'
);
```

## Complete SQL Migration Script

Run this entire script in your Supabase SQL Editor:

```sql
-- Step 1: Add category_id column
ALTER TABLE items 
ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES categories(id);

-- Step 2: Make subcategory_id nullable
ALTER TABLE items 
ALTER COLUMN subcategory_id DROP NOT NULL;

-- Step 3: Add constraint for single parent
ALTER TABLE items 
ADD CONSTRAINT check_single_parent 
CHECK (
  (category_id IS NOT NULL AND subcategory_id IS NULL) OR
  (category_id IS NULL AND subcategory_id IS NOT NULL)
);

-- Step 4: Add index for better query performance
CREATE INDEX IF NOT EXISTS idx_items_category_id ON items(category_id);
CREATE INDEX IF NOT EXISTS idx_items_subcategory_id ON items(subcategory_id);
```

## Rollback (if needed)

If you need to revert these changes:

```sql
-- Remove constraint
ALTER TABLE items DROP CONSTRAINT IF EXISTS check_single_parent;

-- Remove indexes
DROP INDEX IF EXISTS idx_items_category_id;
DROP INDEX IF EXISTS idx_items_subcategory_id;

-- Remove column
ALTER TABLE items DROP COLUMN IF EXISTS category_id;

-- Make subcategory_id required again (only if all items have subcategory_id)
ALTER TABLE items ALTER COLUMN subcategory_id SET NOT NULL;
```

## Testing After Migration

Test the new functionality:

1. Create an item directly under a category:
```bash
curl -X POST http://localhost:3000/items \
  -H "Content-Type: application/json" \
  -d '{
    "category_id": "your-category-uuid",
    "name": "Direct Category Item",
    "pricing_type": "static",
    "pricing_rules": {"base_price": 100}
  }'
```

2. Create an item under a subcategory:
```bash
curl -X POST http://localhost:3000/items \
  -H "Content-Type: application/json" \
  -d '{
    "subcategory_id": "your-subcategory-uuid",
    "name": "Subcategory Item",
    "pricing_type": "static",
    "pricing_rules": {"base_price": 200}
  }'
```

3. Try creating an item with both (should fail):
```bash
curl -X POST http://localhost:3000/items \
  -H "Content-Type: application/json" \
  -d '{
    "category_id": "your-category-uuid",
    "subcategory_id": "your-subcategory-uuid",
    "name": "Invalid Item",
    "pricing_type": "static",
    "pricing_rules": {"base_price": 300}
  }'
```

## Notes

- The application code has been updated to handle both parent types
- Tax inheritance now checks whether item belongs to category or subcategory
- List and search endpoints support filtering by both category_id and subcategory_id
- All existing items with subcategory_id will continue to work without changes
