#!/bin/bash
# Simple HTTP server for viewing examples
# Usage: ./serve.sh

echo "Starting HTTP server on http://localhost:8080"
echo "Open http://localhost:8080/table-demo-integrated.html in your browser"
echo "Press Ctrl+C to stop"
echo ""

# Try Python 3 first, then Python 2, then Node
if command -v python3 &> /dev/null; then
    cd "$(dirname "$0")/.." && python3 -m http.server 8080
elif command -v python &> /dev/null; then
    cd "$(dirname "$0")/.." && python -m SimpleHTTPServer 8080
elif command -v npx &> /dev/null; then
    cd "$(dirname "$0")/.." && npx http-server -p 8080
else
    echo "Error: No HTTP server found. Please install Python or Node.js"
    exit 1
fi
