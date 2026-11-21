#!/bin/bash
# Double-click this to publish the current site to systoned.cc on Cloudflare.
# It uploads the files in the systoned folder. Nothing goes to GitHub.
cd "/Users/jordie/systoned" || { echo "Site folder not found."; read -n 1; exit 1; }
echo "Publishing systoned.cc to Cloudflare..."
echo ""
npx wrangler pages deploy . --project-name systoned --branch main --commit-dirty=true
echo ""
echo "Finished. You can close this window."
read -n 1 -s
