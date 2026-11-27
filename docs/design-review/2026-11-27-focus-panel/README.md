# Design review: the Focus panel

**Operations**, with made-up data: four projects, a run going on in one, three runs queued in two others, a live session open in the fourth. Captured in headless Edge at 1440×1000 (computer) and 390 px wide, emulated (phone), interface in Brazilian Portuguese. The app has one theme, dark.

| Screen | What to check |
|---|---|
| [No restriction, computer](free-desktop-pt-BR.png) | Before this change, Operations started with the run going on. Now the **Focus** panel comes first: one line ("Sem restrição desde …, por pedido do dono"), the three general modes, **Até quando**, and a card per project with its state in words and color (working in green, queued in blue, stopped in grey), who works there and its role, its memory and its live session, and the buttons **Ativo**, **Pausado**, **Foco**. |
| [Focus on one project, computer](focus-desktop-pt-BR.png) | "Foco: só Webshop desde …, até …" and what comes back after it; the mark **Só Webshop** at the top; the projects out of the focus with a dashed edge, "Esperando o foco acabar" and how many runs wait in their queue; their middle button reads **Espera** (grey), not **Ativo**; the project paused alone in amber. |
| [Focus on…, computer](focus-desktop-picker-pt-BR.png) | The picker: what the focus does in one line, a box per project (the current focus ticked), **Focar nestes**; **Últimas mudanças** opened. |
| [Focus on one project, phone](focus-phone-pt-BR.png) | The panel fits the width (no sideways scroll): the modes on one row of 44 px buttons, one card per row, the texts wrapping. The top bar's mark is cut to "Só …" there (the bar is narrow) and opens the panel. |

Not captured: the choice when a change would hold work going on (**Deixar terminar**, **Pausar agora**, **Cancelar**), a small dialog like the app's other confirmations.
