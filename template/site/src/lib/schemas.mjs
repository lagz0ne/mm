// The structured content's schemas (sy-rfup; the one source: bin/lib/schemas/*.v1.json, next to this site in every
// project), for the board's bundle. bin/lib/schemas.mjs is the same list for Node; only the paths differ (test/schema.mjs
// keeps the two lists equal).
import common from '../../../bin/lib/schemas/common.v1.json'
import message from '../../../bin/lib/schemas/message.v1.json'
import task from '../../../bin/lib/schemas/task.v1.json'
import card from '../../../bin/lib/schemas/card.v1.json'

export const SCHEMAS = [common, message, task, card]
