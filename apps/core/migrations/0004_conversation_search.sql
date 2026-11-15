-- 0004: full-text search over everything said in conversations.
--
-- The index keeps its own copy of the text together with the message id.
-- (An index that pointed at rows by their internal row number would be
-- smaller, but SQLite may renumber those rows, which would silently break
-- the search.) Tool traffic and hidden context notes are not indexed.

CREATE VIRTUAL TABLE messages_fts USING fts5 (
  text,
  message_id UNINDEXED,
  conversation_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO messages_fts (text, message_id, conversation_id)
SELECT text, id, conversation_id FROM messages WHERE role IN ('user', 'assistant') AND text != '';

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
WHEN new.role IN ('user', 'assistant') AND new.text != ''
BEGIN
  INSERT INTO messages_fts (text, message_id, conversation_id) VALUES (new.text, new.id, new.conversation_id);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages
BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;
