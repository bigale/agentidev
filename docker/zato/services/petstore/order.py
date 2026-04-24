# -*- coding: utf-8 -*-
"""
Petstore Order + Inventory services for Zato — v2 (idiomatic patterns).

Uses PetstoreService base class from pet.py for shared helpers.
"""
import json
import sqlite3
import os
from dataclasses import dataclass

from zato.server.service import Model, Service

DB_PATH = os.environ.get('PETSTORE_DB', '/opt/zato/petstore.db')


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=5000')
    return conn


def ensure_db():
    if not os.path.exists(DB_PATH):
        from petstore_pet import init_db
        init_db()


# ---- Base Service (duplicated from pet.py — Zato hot-deploy loads each file independently) ----

@dataclass(init=False)
class Meta(Model):
    cid: 'str'
    is_ok: 'bool'
    timestamp: 'str'


class PetstoreService(Service):
    """Base class with meta envelope and helpers."""

    def success_response(self, data):
        self.response.payload = json.dumps({
            'meta': {'cid': self.cid, 'is_ok': True, 'timestamp': str(self.time.utcnow())},
            'data': data,
        })
        self.response.content_type = 'application/json'

    def error_response(self, code, message):
        self.response.status_code = code
        self.response.payload = json.dumps({
            'meta': {'cid': self.cid, 'is_ok': False, 'timestamp': str(self.time.utcnow())},
            'error': {'code': code, 'message': message},
        })
        self.response.content_type = 'application/json'

    def get_path_id(self):
        path = self.request.http.path
        segment = path.rstrip('/').split('/')[-1]
        try:
            return int(segment)
        except (ValueError, TypeError):
            return None


# ---- Services ----

class PlaceOrder(PetstoreService):
    """POST /api/store/order"""
    name = 'petstore.store.place-order'

    def handle(self):
        ensure_db()

        try:
            data = json.loads(self.request.raw_request)
        except (json.JSONDecodeError, TypeError):
            self.error_response(400, 'Invalid JSON')
            return

        self.logger.info(f'cid:{self.cid} -> Placing order for pet: {data.get("petId")}')

        conn = get_db()
        cursor = conn.execute(
            '''INSERT INTO orders (id, pet_id, quantity, ship_date, status, complete)
               VALUES (?, ?, ?, ?, ?, ?)''',
            (
                data.get('id'),
                data.get('petId'),
                data.get('quantity', 1),
                data.get('shipDate'),
                data.get('status', 'placed'),
                1 if data.get('complete') else 0,
            )
        )
        conn.commit()
        order_id = cursor.lastrowid or data.get('id')
        conn.close()

        result = dict(data)
        result['id'] = order_id
        self.response.payload = json.dumps(result)
        self.response.content_type = 'application/json'


class GetOrderById(PetstoreService):
    """GET /api/store/order/id/{orderId}"""
    name = 'petstore.store.get-order-by-id'

    def handle(self):
        ensure_db()
        order_id = self.get_path_id()

        if order_id is None:
            self.error_response(400, 'Invalid order ID')
            return

        self.logger.info(f'cid:{self.cid} -> Getting order: {order_id}')

        conn = get_db()
        row = conn.execute('SELECT * FROM orders WHERE id = ?', (order_id,)).fetchone()
        conn.close()

        if not row:
            self.error_response(404, 'Order not found')
            return

        self.response.payload = json.dumps({
            'id': row['id'],
            'petId': row['pet_id'],
            'quantity': row['quantity'],
            'shipDate': row['ship_date'] or '',
            'status': row['status'],
            'complete': bool(row['complete']),
        })
        self.response.content_type = 'application/json'


class DeleteOrder(PetstoreService):
    """DELETE /api/store/order/delete/{orderId}"""
    name = 'petstore.store.delete-order'

    def handle(self):
        ensure_db()
        order_id = self.get_path_id()

        if order_id is None:
            self.error_response(400, 'Invalid order ID')
            return

        self.logger.info(f'cid:{self.cid} -> Deleting order: {order_id}')

        conn = get_db()
        conn.execute('DELETE FROM orders WHERE id = ?', (order_id,))
        conn.commit()
        conn.close()

        self.success_response({'code': 200, 'message': f'Order {order_id} deleted'})


class GetInventory(PetstoreService):
    """GET /api/store/inventory"""
    name = 'petstore.store.get-inventory'

    def handle(self):
        ensure_db()
        self.logger.info(f'cid:{self.cid} -> Getting inventory')

        conn = get_db()
        rows = conn.execute(
            'SELECT status, COUNT(*) as count FROM pets GROUP BY status'
        ).fetchall()
        conn.close()

        inventory = {}
        for row in rows:
            inventory[row['status']] = row['count']

        self.response.payload = json.dumps(inventory)
        self.response.content_type = 'application/json'
