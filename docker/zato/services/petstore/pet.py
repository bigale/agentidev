# -*- coding: utf-8 -*-
"""
Petstore Pet services for Zato.
Hot-deployed via the pickup directory.

These services use SQLite directly (no ORM) for simplicity.
The quickstart container includes sqlite3 in Python stdlib.
"""
import json
import sqlite3
import os

from zato.server.service import Service

DB_PATH = os.environ.get('PETSTORE_DB', '/opt/zato/petstore.db')


def get_db():
    """Get a SQLite connection with row_factory for dict-like access."""
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=5000')
    return conn


def init_db():
    """Create tables if they don't exist."""
    schema_path = '/opt/zato/sql/petstore-schema.sql'
    if os.path.exists(schema_path):
        conn = get_db()
        with open(schema_path) as f:
            conn.executescript(f.read())
        conn.close()


def row_to_pet(row):
    """Convert a SQLite row to a Petstore API pet dict."""
    return {
        'id': row['id'],
        'name': row['name'],
        'status': row['status'],
        'category': {
            'id': row['category_id'],
            'name': row['category_name'],
        } if row['category_id'] else None,
        'photoUrls': json.loads(row['photo_urls']) if row['photo_urls'] else [],
        'tags': json.loads(row['tags']) if row['tags'] else [],
    }


class PetInit(Service):
    """Initialize the petstore database on first call."""
    name = 'petstore.init'

    def handle(self):
        init_db()
        self.response.payload = json.dumps({'status': 'initialized', 'db': DB_PATH})
        self.response.content_type = 'application/json'


class GetPetsByStatus(Service):
    """GET /api/pet/findByStatus?status=available"""
    name = 'petstore.pet.find-by-status'

    def handle(self):
        # Ensure DB exists
        if not os.path.exists(DB_PATH):
            init_db()

        status = self.request.http.GET.get('status', 'available')

        conn = get_db()
        rows = conn.execute(
            'SELECT * FROM pets WHERE status = ?', (status,)
        ).fetchall()
        conn.close()

        pets = [row_to_pet(r) for r in rows]
        self.response.payload = json.dumps(pets)
        self.response.content_type = 'application/json'


class GetPetById(Service):
    """GET /api/pet/{petId}"""
    name = 'petstore.pet.get-by-id'

    def handle(self):
        if not os.path.exists(DB_PATH):
            init_db()

        # Extract pet_id from URL path
        path = self.request.http.path
        pet_id = path.rstrip('/').split('/')[-1]

        try:
            pet_id = int(pet_id)
        except (ValueError, TypeError):
            self.response.status_code = 400
            self.response.payload = json.dumps({
                'code': 400, 'message': 'Invalid pet ID: ' + str(pet_id)
            })
            self.response.content_type = 'application/json'
            return

        conn = get_db()
        row = conn.execute('SELECT * FROM pets WHERE id = ?', (pet_id,)).fetchone()
        conn.close()

        if not row:
            self.response.status_code = 404
            self.response.payload = json.dumps({
                'code': 404, 'message': 'Pet not found'
            })
            self.response.content_type = 'application/json'
            return

        self.response.payload = json.dumps(row_to_pet(row))
        self.response.content_type = 'application/json'


class AddPet(Service):
    """POST /api/pet"""
    name = 'petstore.pet.add'

    def handle(self):
        if not os.path.exists(DB_PATH):
            init_db()

        try:
            data = json.loads(self.request.raw_request)
        except (json.JSONDecodeError, TypeError):
            self.response.status_code = 400
            self.response.payload = json.dumps({
                'code': 400, 'message': 'Invalid JSON body'
            })
            self.response.content_type = 'application/json'
            return

        name = data.get('name', '')
        if not name:
            self.response.status_code = 400
            self.response.payload = json.dumps({
                'code': 400, 'message': 'name is required'
            })
            self.response.content_type = 'application/json'
            return

        conn = get_db()
        cursor = conn.execute(
            '''INSERT INTO pets (id, name, status, category_id, category_name, photo_urls, tags)
               VALUES (?, ?, ?, ?, ?, ?, ?)''',
            (
                data.get('id'),
                name,
                data.get('status', 'available'),
                data.get('category', {}).get('id') if isinstance(data.get('category'), dict) else None,
                data.get('category', {}).get('name') if isinstance(data.get('category'), dict) else None,
                json.dumps(data.get('photoUrls', [])),
                json.dumps(data.get('tags', [])),
            )
        )
        conn.commit()
        pet_id = cursor.lastrowid or data.get('id')
        conn.close()

        result = dict(data)
        result['id'] = pet_id
        self.response.payload = json.dumps(result)
        self.response.content_type = 'application/json'


class UpdatePet(Service):
    """PUT /api/pet"""
    name = 'petstore.pet.update'

    def handle(self):
        if not os.path.exists(DB_PATH):
            init_db()

        try:
            data = json.loads(self.request.raw_request)
        except (json.JSONDecodeError, TypeError):
            self.response.status_code = 400
            self.response.payload = json.dumps({'code': 400, 'message': 'Invalid JSON'})
            self.response.content_type = 'application/json'
            return

        pet_id = data.get('id')
        if not pet_id:
            self.response.status_code = 400
            self.response.payload = json.dumps({'code': 400, 'message': 'id required'})
            self.response.content_type = 'application/json'
            return

        conn = get_db()
        conn.execute(
            '''UPDATE pets SET name=?, status=?, category_id=?, category_name=?, photo_urls=?, tags=?
               WHERE id=?''',
            (
                data.get('name', ''),
                data.get('status', 'available'),
                data.get('category', {}).get('id') if isinstance(data.get('category'), dict) else None,
                data.get('category', {}).get('name') if isinstance(data.get('category'), dict) else None,
                json.dumps(data.get('photoUrls', [])),
                json.dumps(data.get('tags', [])),
                pet_id,
            )
        )
        conn.commit()
        conn.close()

        self.response.payload = json.dumps(data)
        self.response.content_type = 'application/json'


class DeletePet(Service):
    """DELETE /api/pet/{petId}"""
    name = 'petstore.pet.delete'

    def handle(self):
        if not os.path.exists(DB_PATH):
            init_db()

        path = self.request.http.path
        pet_id = path.rstrip('/').split('/')[-1]

        try:
            pet_id = int(pet_id)
        except (ValueError, TypeError):
            self.response.status_code = 400
            self.response.payload = json.dumps({'code': 400, 'message': 'Invalid pet ID'})
            self.response.content_type = 'application/json'
            return

        conn = get_db()
        conn.execute('DELETE FROM pets WHERE id = ?', (pet_id,))
        conn.commit()
        conn.close()

        self.response.payload = json.dumps({'code': 200, 'message': 'Pet deleted'})
        self.response.content_type = 'application/json'
