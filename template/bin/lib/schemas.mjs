// The structured content's schemas (sy-rfup; the one source: bin/lib/schemas/*.v1.json), for Node. The board's browser
// code has its own copy of this file (site/src/lib/schemas.mjs) that imports the same JSON files for its bundle; only the
// paths differ (test/schema.mjs keeps the two lists equal).
import common from './schemas/common.v1.json' with { type: 'json' }
import message from './schemas/message.v1.json' with { type: 'json' }
import task from './schemas/task.v1.json' with { type: 'json' }
import card from './schemas/card.v1.json' with { type: 'json' }

export const SCHEMAS = [common, message, task, card]
