# -*- coding: utf-8 -*-
"""
Petstore Order + Inventory services for Zato.
"""
import json
import sqlite3
import os

from zato.server.service import Service

DB_PATH = os.environ.get('PETSTORE_DB', '/opt/zato/petstore.db')


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=5000')
    return conn


class PlaceOrder(Service):
    """POST /api/store/order"""
    name = 'petstore.store.place-order'

    def handle(self):
        try:
            data = json.loads(self.request.raw_request)
        except (json.JSONDecodeError, TypeError):
            self.response.status_code = 400
            self.response.payload = json.dumps({'code': 400, 'message': 'Invalid JSON'})
            self.response.content_type = 'application/json'
            return

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


class GetOrderById(Service):
    """GET /api/store/order/id/{orderId}"""
    name = 'petstore.store.get-order-by-id'

    def handle(self):
        path = self.request.http.path
        order_id = path.rstrip('/').split('/')[-1]

        try:
            order_id = int(order_id)
        except (ValueError, TypeError):
            self.response.status_code = 400
            self.response.payload = json.dumps({'code': 400, 'message': 'Invalid order ID'})
            self.response.content_type = 'application/json'
            return

        conn = get_db()
        row = conn.execute('SELECT * FROM orders WHERE id = ?', (order_id,)).fetchone()
        conn.close()

        if not row:
            self.response.status_code = 404
            self.response.payload = json.dumps({'code': 404, 'message': 'Order not found'})
            self.response.content_type = 'application/json'
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


class DeleteOrder(Service):
    """DELETE /api/store/order/delete/{orderId}"""
    name = 'petstore.store.delete-order'

    def handle(self):
        path = self.request.http.path
        order_id = path.rstrip('/').split('/')[-1]

        try:
            order_id = int(order_id)
        except (ValueError, TypeError):
            self.response.status_code = 400
            self.response.payload = json.dumps({'code': 400, 'message': 'Invalid order ID'})
            self.response.content_type = 'application/json'
            return

        conn = get_db()
        conn.execute('DELETE FROM orders WHERE id = ?', (order_id,))
        conn.commit()
        conn.close()

        self.response.payload = json.dumps({'code': 200, 'message': 'Order deleted'})
        self.response.content_type = 'application/json'


class GetInventory(Service):
    """GET /api/store/inventory"""
    name = 'petstore.store.get-inventory'

    def handle(self):
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
