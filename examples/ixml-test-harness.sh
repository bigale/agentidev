#!/bin/bash
# IXML Test Harness
# Automatically test preprocessing + grammar combinations

MARKUP_BLITZ="/home/bigale/repos/markup-blitz/build/libs/markup-blitz.jar"
TEST_DIR="/home/bigale/repos/contextual-recall/examples/test-cases"
GRAMMAR_DIR="/home/bigale/repos/contextual-recall/examples/grammars"
PREPROCESS_DIR="/home/bigale/repos/contextual-recall/examples/preprocessors"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🔬 IXML Test Harness"
echo "===================="
echo ""

# Test cases
declare -A TEST_CASES
TEST_CASES["simple_form"]='<form action="/submit"><label>Name:</label><input type="text" name="name"></form>'
TEST_CASES["login_form"]='<form action="/login"><label>Email:</label><input type="email" name="email"><label>Password:</label><input type="password" name="pwd"><input type="submit" value="Login"></form>'

# Track results
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Run a single test
run_test() {
    local test_name=$1
    local html_input=$2
    local preprocessor=$3
    local grammar=$4

    TOTAL_TESTS=$((TOTAL_TESTS + 1))

    echo -n "Testing: $test_name with $preprocessor + $(basename $grammar) ... "

    # Run preprocessor
    local preprocessed
    if [ -f "$preprocessor" ]; then
        preprocessed=$(node "$preprocessor" "$html_input" 2>&1)
        if [ $? -ne 0 ]; then
            echo -e "${RED}FAIL${NC} (preprocessing failed)"
            FAILED_TESTS=$((FAILED_TESTS + 1))
            return 1
        fi
    else
        preprocessed="$html_input"
    fi

    # Run IXML parser
    local result
    result=$(java -jar "$MARKUP_BLITZ" "$grammar" "!$preprocessed" 2>&1)
    local exit_code=$?

    # Check if parse succeeded
    if echo "$result" | grep -q "error" || [ $exit_code -ne 0 ]; then
        echo -e "${RED}FAIL${NC}"
        echo "  Preprocessed: $preprocessed"
        echo "  Error: $(echo "$result" | head -3)"
        FAILED_TESTS=$((FAILED_TESTS + 1))
        return 1
    else
        echo -e "${GREEN}PASS${NC}"
        PASSED_TESTS=$((PASSED_TESTS + 1))
        return 0
    fi
}

# Find all grammars
echo "Looking for grammars in $GRAMMAR_DIR..."
if [ ! -d "$GRAMMAR_DIR" ]; then
    mkdir -p "$GRAMMAR_DIR"
fi

GRAMMARS=$(find "$GRAMMAR_DIR" -name "*.ixml" 2>/dev/null)
if [ -z "$GRAMMARS" ]; then
    echo -e "${YELLOW}No grammars found. Place .ixml files in $GRAMMAR_DIR${NC}"
    exit 1
fi

# Find all preprocessors
echo "Looking for preprocessors in $PREPROCESS_DIR..."
if [ ! -d "$PREPROCESS_DIR" ]; then
    mkdir -p "$PREPROCESS_DIR"
fi

PREPROCESSORS=$(find "$PREPROCESS_DIR" -name "*.js" 2>/dev/null)
if [ -z "$PREPROCESSORS" ]; then
    echo -e "${YELLOW}No preprocessors found. Using raw HTML.${NC}"
    PREPROCESSORS="none"
fi

echo ""
echo "Running tests..."
echo "================"

# Test all combinations
for test_name in "${!TEST_CASES[@]}"; do
    html="${TEST_CASES[$test_name]}"

    for grammar in $GRAMMARS; do
        for preprocessor in $PREPROCESSORS; do
            run_test "$test_name" "$html" "$preprocessor" "$grammar"
        done
    done
done

# Summary
echo ""
echo "Summary"
echo "======="
echo -e "Total:  $TOTAL_TESTS"
echo -e "Passed: ${GREEN}$PASSED_TESTS${NC}"
echo -e "Failed: ${RED}$FAILED_TESTS${NC}"

if [ $FAILED_TESTS -eq 0 ]; then
    echo -e "\n${GREEN}✓ All tests passed!${NC}"
    exit 0
else
    echo -e "\n${RED}✗ Some tests failed${NC}"
    exit 1
fi
