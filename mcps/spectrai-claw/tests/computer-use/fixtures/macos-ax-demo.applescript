tell application "TextEdit"
  activate
  make new document with properties {text:"Computer Use AX demo\nInitial text for semantic input verification."}
end tell

-- Manual validation target:
-- 1. Grant Accessibility and Screen Recording permissions to the SpectrAI Claw helper.
-- 2. Bind provider to bundle id com.apple.TextEdit.
-- 3. Read AX tree and locate AXTextArea.
-- 4. Set text via AX action/value path, then verify the document content changed.
