# Design review: ordering the queue

**Operations** and a project's **Tasks and history** tab, with made-up data: four projects and eight runs in the queue: one that resumes first (paused for an update), one on **Do now** for its project, one waiting for it, one held by the owner with a reason, one held by the manager, one waiting for the plan's limit. Captured in headless Edge at 1440×1000 (computer) and 390×844 with touch (phone), interface in Brazilian Portuguese. The app has one theme, dark.

| Screen | What to check |
|---|---|
| [Before, computer](before-queue-desktop-pt-BR.png) | The queue as it was: runs in the order asked, no way to change it but **Cancelar**; at this width the table slid under the side column, so **Início previsto** was cut and **Cancelar** hidden. |
| [Before, phone](before-queue-phone-pt-BR.png) | The same queue as cards, **Cancelar** on each. |
| [Queue, computer](after-queue-desktop-pt-BR.png) | The table keeps to its column (the side column goes under the work below 1280 px). Above it, the **Fazer agora** band: which run, what waits for it, **Soltar as outras**. Each row: its place (drag it by the dotted mark), the marks **Próxima**, **Fazer agora**, **Retoma primeiro**, **Segurada por você**, **Segurada pelo Gerente** (amber), the reason in amber under a held run, **Início previsto** (the state only when it isn't plain "na fila"), ▲ ▼, **Soltar** for a held run, **Ações**. The run that resumes first has ▲ ▼ off and no drag mark; the first and last ▲ / ▼ are off. **Últimas mudanças na fila** under the list. |
| [Actions, computer](after-queue-desktop-menu-pt-BR.png) | **Passar para o topo**, **Fazer agora…**, **Segurar…**, **Cancelar…** (red). |
| [Do now, computer](after-do-now-dialog-desktop-pt-BR.png) | Which runs wait: **Só as de App de agenda** (brass) or **Todas as outras**; the note says it takes the place of the current **Fazer agora** (or that the project has a run going on, or is held in Focus). |
| [Hold, computer](after-hold-dialog-desktop-pt-BR.png) | The reason, optional, shown in the queue; Enter holds. |
| [A project's queue, computer](after-project-queue-desktop-pt-BR.png) | The project's runs with their place in the whole queue, the same marks and controls (▲ ▼ move past the project's own runs). |
| [Queue, phone](after-queue-phone-pt-BR.png) | No sideways scroll; buttons of 44 px; **Início previsto** on the left and ▲ ▼ **Ações** on the right of one line; **Soltar as outras** across the band. |
| [Held runs, phone](after-queue-phone-held-pt-BR.png) | The amber edge on the whole card, the mark and the reason; **Soltar** beside ▲ ▼. |
| [Do now, phone](after-do-now-dialog-phone-pt-BR.png) | The dialog's buttons wrap to fit. |
| [A project's queue, phone](after-project-queue-phone-pt-BR.png) | Titles wrap (no longer cut), controls under each run. |

Not captured: dragging a row (a brass line shows where it goes) and the confirmation of **Cancelar**, the app's usual dialog.
