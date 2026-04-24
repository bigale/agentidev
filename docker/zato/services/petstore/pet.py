# -*- coding: utf-8 -*-
"""
Petstore Pet services for Zato — v2 (idiomatic patterns).

Follows the Zato REST tutorial best practices:
- Dataclass Models for typed input/output (SIO)
- Meta response envelope with correlation ID and timestamp
- Base service class with shared helpers
- Proper logging via self.logger
"""
import json
import sqlite3
import os
from dataclasses import dataclass

from zato.server.service import Model, Service

DB_PATH = os.environ.get('PETSTORE_DB', '/opt/zato/petstore.db')


# ---- Database helpers ----

def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=5000')
    return conn


def init_db():
    schema_path = '/opt/zato/sql/petstore-schema.sql'
    if os.path.exists(schema_path):
        conn = get_db()
        with open(schema_path) as f:
            conn.executescript(f.read())
        conn.close()


def ensure_db():
    if not os.path.exists(DB_PATH):
        init_db()


def row_to_pet(row):
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


# ---- SIO Models ----

@dataclass(init=False)
class Meta(Model):
    cid: 'str'
    is_ok: 'bool'
    timestamp: 'str'


# ---- Base Service ----

class PetstoreService(Service):
    """Base class for all Petstore services. Provides meta envelope."""

    def get_meta(self, is_ok=True):
        meta = Meta()
        meta.cid = self.cid
        meta.is_ok = is_ok
        meta.timestamp = self.time.utcnow()
        return meta

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

    def get_query_param(self, name, default=None):
        """Read a query param from QUERY_STRING (Zato 3.3 compat)."""
        qs = self.wsgi_environ.get('QUERY_STRING', '')
        for param in qs.split('&'):
            if param.startswith(name + '='):
                return param.split('=', 1)[1]
        return default

    def get_path_id(self):
        """Extract the last path segment as an integer ID."""
        path = self.request.http.path
        segment = path.rstrip('/').split('/')[-1]
        try:
            return int(segment)
        except (ValueError, TypeError):
            return None


# ---- Services ----

class PetInit(PetstoreService):
    """POST /api/pet/init — initialize the database."""
    name = 'petstore.init'

    def handle(self):
        init_db()
        self.logger.info(f'cid:{self.cid} -> Petstore DB initialized: {DB_PATH}')
        self.success_response({'status': 'initialized', 'db': DB_PATH})


class GetPetsByStatus(PetstoreService):
    """GET /api/pet/findByStatus?status=available"""
    name = 'petstore.pet.find-by-status'

    def handle(self):
        ensure_db()
        status = self.get_query_param('status', 'available')
        self.logger.info(f'cid:{self.cid} -> Finding pets by status: {status}')

        conn = get_db()
        rows = conn.execute('SELECT * FROM pets WHERE status = ?', (status,)).fetchall()
        conn.close()

        pets = [row_to_pet(r) for r in rows]
        # Return as array (SmartClient RestDataSource expects array for fetch)
        self.response.payload = json.dumps(pets)
        self.response.content_type = 'application/json'


class GetPetById(PetstoreService):
    """GET /api/pet/id/{petId}"""
    name = 'petstore.pet.get-by-id'

    def handle(self):
        ensure_db()
        pet_id = self.get_path_id()

        if pet_id is None:
            self.error_response(400, 'Invalid pet ID')
            return

        self.logger.info(f'cid:{self.cid} -> Getting pet: {pet_id}')

        conn = get_db()
        row = conn.execute('SELECT * FROM pets WHERE id = ?', (pet_id,)).fetchone()
        conn.close()

        if not row:
            self.error_response(404, 'Pet not found')
            return

        self.response.payload = json.dumps(row_to_pet(row))
        self.response.content_type = 'application/json'


class AddPet(PetstoreService):
    """POST /api/pet"""
    name = 'petstore.pet.add'

    def handle(self):
        ensure_db()

        try:
            data = json.loads(self.request.raw_request)
        except (json.JSONDecodeError, TypeError):
            self.error_response(400, 'Invalid JSON body')
            return

        name = data.get('name', '')
        if not name:
            self.error_response(400, 'name is required')
            return

        self.logger.info(f'cid:{self.cid} -> Adding pet: {name}')

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


class UpdatePet(PetstoreService):
    """PUT /api/pet/update"""
    name = 'petstore.pet.update'

    def handle(self):
        ensure_db()

        try:
            data = json.loads(self.request.raw_request)
        except (json.JSONDecodeError, TypeError):
            self.error_response(400, 'Invalid JSON')
            return

        pet_id = data.get('id')
        if not pet_id:
            self.error_response(400, 'id required')
            return

        self.logger.info(f'cid:{self.cid} -> Updating pet: {pet_id}')

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


class DeletePet(PetstoreService):
    """DELETE /api/pet/delete/{petId}"""
    name = 'petstore.pet.delete'

    def handle(self):
        ensure_db()
        pet_id = self.get_path_id()

        if pet_id is None:
            self.error_response(400, 'Invalid pet ID')
            return

        self.logger.info(f'cid:{self.cid} -> Deleting pet: {pet_id}')

        conn = get_db()
        conn.execute('DELETE FROM pets WHERE id = ?', (pet_id,))
        conn.commit()
        conn.close()

        self.success_response({'code': 200, 'message': f'Pet {pet_id} deleted'})
