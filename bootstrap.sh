#!/bin/bash
export NODE_NO_WARNINGS=1

# Safe Mode: ./bootstrap.sh --safe-mode → nonaktifkan startup scripts (rc.local)
SAFE_MODE=""
if [ "$1" = "--safe-mode" ]; then
    SAFE_MODE="--safe-mode"
fi

while true; do
    echo ""
    echo "========================================"
    echo "  TSIX Bootstrap - Starting System"
    if [ -n "$SAFE_MODE" ]; then
        echo "  SAFE MODE (startup scripts disabled)"
    fi
    echo "========================================"
    echo ""
    
    node -r esbuild-register -r tsconfig-paths/register --max-old-space-size=8192 src/main.ts $SAFE_MODE
    EXIT_CODE=$?
    
    if [ $EXIT_CODE -eq 0 ]; then
        echo ""
        echo "========================================"
        echo "  System halted."
        echo "========================================"
        break
    elif [ $EXIT_CODE -eq 1 ]; then
        echo ""
        echo "========================================"
        echo "  System is rebooting..."
        echo "========================================"
        sleep 2
        continue
    else
        echo ""
        echo "========================================"
        echo "  Unexpected error: $EXIT_CODE"
        echo "========================================"
        break
    fi
done
