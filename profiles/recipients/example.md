# Recipient profile (example)

A reusable profile for someone you buy gifts for. Copy to `profiles/recipients/<name>.md` (git-ignored)
and edit. Discern reads the fenced `json` block below.

Recipient profiles build up over time (`occasion_history` avoids repeat gifts) so gifting gets smarter.

```json
{
  "schema_version": "0.1.0",
  "kind": "recipient",
  "name": "Mom",
  "relationship": "mother",
  "occasion_history": [
    { "occasion": "birthday", "date": "2025-09", "gift": "cashmere scarf" }
  ],
  "value_framework": {
    "principles": [
      "thoughtful and practical over flashy",
      "quality she will actually use"
    ],
    "prefers_handmade_local": true,
    "markup_tolerance": "moderate"
  },
  "hard_filters": [
    { "dimension": "allergy", "rule": "no wool (sensitive skin)", "applies_to_gifts": true }
  ],
  "preferences": [
    { "dimension": "color", "preference": "warm neutrals", "weight": "medium" }
  ],
  "category_budgets": [
    { "category": "gift-birthday", "currency": "USD", "typical_max": 120, "target": 80 }
  ],
  "sizes": { "tops": "M", "shoes_us_women": "8" }
}
```

### Notes
- The recipient's `hard_filters` (e.g. an allergy) DO apply to their gifts — that's the point of
  `applies_to_gifts: true`.
- `value_framework` here is the *recipient's* taste as you understand it, not yours.
