import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/** "Who are you?": the name your changes and comments carry. Stored in a cookie on this browser. */
export function Identify({ open, current, onOpenChange, onDone }: {
  open: boolean; current: string; onOpenChange: (o: boolean) => void; onDone: (name: string) => void
}) {
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setName(current); setErr('') } }, [open, current])
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try { const r = await api.identify(name); onDone(r.actor); onOpenChange(false) }
    catch (x) { setErr((x as Error).message) }
    finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 border-t-4 border-t-foreground p-0 sm:max-w-sm">
        <form onSubmit={submit}>
          <DialogHeader className="border-b px-5 py-3">
            <DialogTitle className="text-base font-bold">Who are you?</DialogTitle>
            <DialogDescription className="text-xs">Your items and comments show this name. Leads reply to it.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 px-5 py-4">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. alex" aria-label="Your name" />
            {err && <p className="text-xs text-swiss">{err}</p>}
          </div>
          <DialogFooter className="border-t px-5 py-3">
            <Button type="submit" size="sm" disabled={busy || !name.trim()}>Continue</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
