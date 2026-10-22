/** In-field clear (×) — visible as a red cross when the text field is hovered. */
export function FieldClearButton({
  visible,
  onClear,
  label = 'Clear',
}: {
  visible: boolean
  onClear: () => void
  label?: string
}) {
  if (!visible) return null
  return (
    <button
      type="button"
      className="field-clear"
      aria-label={label}
      title={label}
      tabIndex={-1}
      onMouseDown={(e) => {
        // Keep focus on the input; clear on click without stealing focus first.
        e.preventDefault()
      }}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onClear()
      }}
    >
      ×
    </button>
  )
}
