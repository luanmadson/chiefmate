# Design review: an Approve that failed, and pull requests in conflict

**Decisions**, with made-up data: eight merge cards, one in each state. Captured in headless Edge at 1440 px wide (computer) and 390×844 with touch (phone), the page grown to show every card, interface in Brazilian Portuguese. The app has one theme, dark.

| Screen | What to check |
|---|---|
| [All, computer](decisions-desktop-pt-BR.png) · [phone](decisions-phone-pt-BR.png) | The card you can decide comes first; then the ones with no Approve now, in the alert color (a red edge and tint) with a square **!** mark. The menu's **Decisões** counts only the first: the others wait for a fix. **O Gerente vai resolver (1)**, opened, holds the fix you already approved. |
| Normal: [computer](card-0-normal-desktop-pt-BR.png) · [phone](card-0-normal-phone-pt-BR.png) | As before, for comparison: **Aprovar**. |
| Approve failed, fix queued: [computer](card-1-failed-fix-queued-desktop-pt-BR.png) · [phone](card-1-failed-fix-queued-phone-pt-BR.png) | **APROVAÇÃO FALHOU**; "Você aprovou às 22:47; o GitHub recusou: conflito com a main."; in the button's place, **Correção na fila:** and the fix's title, a link to its run. |
| Fix in progress: [computer](card-2-failed-fix-running-desktop-pt-BR.png) · [phone](card-2-failed-fix-running-phone-pt-BR.png) | **Correção em andamento:** (a blue square). |
| In conflict before any click: [computer](card-3-conflict-before-click-desktop-pt-BR.png) · [phone](card-3-conflict-before-click-phone-pt-BR.png) | **EM CONFLITO**; "Em conflito com a main desde 22:58: não junta mais limpo, e aprovar agora falharia."; the files in conflict under **Detalhes**; the fix Chiefmate queued. |
| No fix yet: [computer](card-4-failed-waiting-manager-desktop-pt-BR.png) · [phone](card-4-failed-waiting-manager-phone-pt-BR.png) | **Aguardando o Gerente** (an amber square). |
| Not a conflict: [computer](card-5-failed-not-conflict-try-again-desktop-pt-BR.png) · [phone](card-5-failed-not-conflict-try-again-phone-pt-BR.png) | GitHub's own reason; **Aguardando o Gerente** and **Tentar de novo** (confirmed first), for once the cause is fixed. |
| Fix ready: [computer](card-6-failed-fix-ready-desktop-pt-BR.png) · [phone](card-6-failed-fix-ready-phone-pt-BR.png) | **Correção pronta:** (a brass square): its card waits for the manager. |
| The fix you already approved: [computer](card-7-fix-approved-by-you-desktop-pt-BR.png) · [phone](card-7-fix-approved-by-you-phone-pt-BR.png) | **Aprovado por você** in place of the level; "Você já aprovou o conteúdo; o Gerente junta depois da revisão." It folds with the manager's cards; **Aprovar** stays for you. |

Not captured: **Correção juntada** (a green square, for the minutes until GitHub marks the old pull request as merged and its card leaves), **Correção parada; aguardando o Gerente** (the fix failed), and the toast of a click on a stale page ("Já aprovado: nada foi tentado de novo…").
