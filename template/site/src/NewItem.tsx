import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type Issue } from '@/lib/api'
import { PRIORITIES, ROLES, ROLE_LABEL, TYPES } from '@/lib/board'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const NONE = '_none'

export function NewItem({ open, onOpenChange, epics, defaultRole, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; epics: Issue[]; defaultRole: string; onCreated: (i: Issue) => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState('task')
  const [role, setRole] = useState(NONE)
  const [priority, setPriority] = useState('2')
  const [parent, setParent] = useState(NONE)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) { setTitle(''); setDescription(''); setType('task'); setPriority('2'); setParent(NONE); setRole(defaultRole || NONE) }
  }, [open, defaultRole])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setBusy(true)
    try {
      const issue = await api.create({
        title: title.trim(), description: description.trim() || undefined, issue_type: type, priority: Number(priority),
        assignee: role === NONE ? undefined : role, parent_id: parent === NONE ? undefined : parent,
      })
      onCreated(issue)
      onOpenChange(false)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 border-t-4 border-t-foreground p-0 sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader className="border-b px-5 py-3">
            <DialogTitle className="text-base font-bold">New item</DialogTitle>
            <DialogDescription className="text-xs">Goes on the board as ready unless something blocks it. A role's lead picks it up.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 px-5 py-4">
            <div className="grid gap-1.5">
              <Label htmlFor="ni-title">Title</Label>
              <Input id="ni-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short, imperative" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ni-desc">Description</Label>
              <Textarea id="ni-desc" rows={4} value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="What and why. Acceptance criteria." className="text-[13px]" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Pick label="Type" value={type} onChange={setType} options={TYPES.map((t) => [t, t])} />
              <Pick label="Role" value={role} onChange={setRole}
                options={[[NONE, 'Unassigned'], ...ROLES.map((r) => [r, ROLE_LABEL[r]] as [string, string])]} />
              <Pick label="Priority" value={priority} onChange={setPriority} options={PRIORITIES.map((p) => [String(p), `P${p}`])} />
            </div>
            {epics.length > 0 && (
              <Pick label="Part of" value={parent} onChange={setParent}
                options={[[NONE, 'No epic'], ...epics.map((e) => [e.id, `${e.id} · ${e.title}`] as [string, string])]} />
            )}
          </div>
          <DialogFooter className="border-t px-5 py-3">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={busy || !title.trim()}>Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Pick({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: [string, string][]
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  )
}
