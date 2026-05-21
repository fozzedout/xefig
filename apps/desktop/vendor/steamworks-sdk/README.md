# Steamworks SDK (vendored locally per-developer)

The Steamworks SDK is **NDA-restricted** and cannot be committed to
source control. Each developer who needs to build the desktop client
has to fetch their own copy.

## How to populate this directory

1. Download the SDK zip from
   <https://partner.steamgames.com/downloads/list> (you need a
   Steamworks account with access to a registered app).
2. From the repo root, run:
   ```
   npm run desktop:setup-sdk
   ```
   That defaults to the newest `steamworks_sdk_*.zip` in `~/Downloads`.
   To use a different file:
   ```
   npm --prefix apps/desktop run setup-sdk -- /path/to/sdk.zip
   ```
3. Once extracted, you should see a `sdk/` subdirectory next to this
   README. That's the path `STEAM_SDK_PATH` should point to when you
   build greenworks.

The unzipped contents are listed in `apps/desktop/.gitignore` so they
will not show up in `git status`.
