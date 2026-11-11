#!/bin/sh
# Launch a headless Thunderbird on the throwaway test profile with Marionette.
cd "$(dirname "$0")/.."
MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 exec /snap/bin/thunderbird --no-remote -profile "$PWD/test/profile" --headless --marionette > test/tb.log 2>&1
