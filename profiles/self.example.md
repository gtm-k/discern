# Self profile (example)

Your own preferences and value framework. Copy this to `profiles/self.md` (git-ignored) and edit.
Discern reads the fenced `json` block below; the prose around it is for you.

The **value framework** is the heart of the profile — it's what makes Discern's picks feel like *yours*
rather than a generic ranker's. Be opinionated here.

```json
{
  "schema_version": "0.1.0",
  "kind": "self",
  "value_framework": {
    "principles": [
      "value != price; value != markup",
      "handmade or locally-made = real value, even when it isn't 'luxury'",
      "reject large markups that have no underlying substance",
      "longevity and repairability beat novelty"
    ],
    "prefers_handmade_local": true,
    "markup_tolerance": "low"
  },
  "hard_filters": [
    {
      "dimension": "materials",
      "rule": "clothing must be natural / non-synthetic (linen, cotton, wool); avoid polyester/acrylic",
      "applies_to_gifts": false
    }
  ],
  "preferences": [
    { "dimension": "style", "preference": "classic, understated, long-lasting", "weight": "high" },
    { "dimension": "durability", "preference": "built to last; serviceable / repairable", "weight": "high" }
  ],
  "category_budgets": [
    { "category": "headphones", "currency": "USD", "typical_max": 350, "target": 200 },
    { "category": "clothing-everyday", "currency": "USD", "typical_max": 150 }
  ],
  "brand_trust": {
    "trusted": [],
    "distrusted": []
  }
}
```

### Notes on the fields
- `hard_filters[].applies_to_gifts` — most of your *own* filters (e.g. natural-materials) should NOT
  auto-apply when you're buying for someone else; the recipient's profile governs that purchase.
- `category_budgets` set the "good enough" bar so the price/value gate (applied last) knows when a cheaper
  option clears it.
- `brand_trust.trusted` feeds the brand-as-proxy step for brand-new releases with thin reviews.
