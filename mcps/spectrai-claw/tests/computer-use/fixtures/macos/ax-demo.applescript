-- macOS AX manual/demo fixture for Universal Computer Use Runtime.
-- Run on macOS after granting Accessibility and Automation permission to the terminal app:
--   osascript tests/computer-use/fixtures/macos/ax-demo.applescript
-- Expected: TextEdit launches/activates and creates a new document if the AX/menu action is permitted.

tell application "TextEdit"
  activate
end tell

delay 1

tell application "System Events"
  if UI elements enabled is false then
    error "Accessibility permission is not enabled for System Events/terminal. Grant it in System Settings > Privacy & Security > Accessibility."
  end if
  tell process "TextEdit"
    set frontmost to true
    click menu item "New" of menu "File" of menu bar 1
  end tell
end tell

return "macos-ax-demo-button: attempted TextEdit File > New via AX/System Events"
