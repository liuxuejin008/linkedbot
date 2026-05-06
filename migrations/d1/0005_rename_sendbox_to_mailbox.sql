-- Migration: rename sendbox to mailbox
ALTER TABLE channels RENAME COLUMN sendbox_response TO mailbox_response;

-- Update existing mode values
UPDATE channels SET mode = 'mailbox' WHERE mode = 'sendbox';
