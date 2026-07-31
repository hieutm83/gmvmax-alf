CREATE TABLE IF NOT EXISTS sku_unit_costs (
  shop_cipher TEXT NOT NULL,
  sku_key TEXT NOT NULL,
  unit_cost INTEGER NOT NULL DEFAULT 40000 CHECK(unit_cost >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (shop_cipher, sku_key)
);
