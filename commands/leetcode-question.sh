#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Leetcode Question
# @raycast.mode fullOutput

# Optional parameters:
# @raycast.icon 🧠
# @raycast.argument1 { "type": "text", "placeholder": "Question Number" }
# @raycast.packageName Dev Utils

# Documentation:
# @raycast.description Automatically creates Obsidian note and code file for a LeetCode question
# @raycast.author Daniel Kumlin

# Change to the leetcode-automation directory and run the script
cd /Users/danielkumlin/Projects/leetcode-automation
bun index.ts "$1"
