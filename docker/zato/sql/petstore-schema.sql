-- Petstore SQLite schema for Zato services
-- Run: sqlite3 /opt/zato/petstore.db < petstore-schema.sql

CREATE TABLE IF NOT EXISTS pets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'available' CHECK(status IN ('available', 'pending', 'sold')),
    category_id INTEGER,
    category_name TEXT,
    photo_urls TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pet_id INTEGER,
    quantity INTEGER DEFAULT 1,
    ship_date TEXT,
    status TEXT DEFAULT 'placed' CHECK(status IN ('placed', 'approved', 'delivered')),
    complete INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seed data
INSERT OR IGNORE INTO pets (id, name, status, category_id, category_name, photo_urls, tags) VALUES
    (1, 'Rex', 'available', 1, 'Dogs', '["https://example.com/rex.jpg"]', '[{"id":1,"name":"friendly"}]'),
    (2, 'Whiskers', 'pending', 2, 'Cats', '["https://example.com/whiskers.jpg"]', '[{"id":2,"name":"indoor"}]'),
    (3, 'Goldie', 'sold', 3, 'Fish', '["https://example.com/goldie.jpg"]', '[{"id":3,"name":"aquatic"}]'),
    (4, 'Buddy', 'available', 1, 'Dogs', '["https://example.com/buddy.jpg"]', '[{"id":1,"name":"friendly"}]'),
    (5, 'Mittens', 'available', 2, 'Cats', '["https://example.com/mittens.jpg"]', '[{"id":2,"name":"indoor"}]');

INSERT OR IGNORE INTO orders (id, pet_id, quantity, status, complete) VALUES
    (1, 1, 1, 'placed', 0),
    (2, 3, 1, 'delivered', 1);
