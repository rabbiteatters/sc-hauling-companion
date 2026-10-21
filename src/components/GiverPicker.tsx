import { SuggestPopup } from './SuggestPopup'

interface Props {
  givers: string[]
  value: string
  onChange: (name: string) => void
  idPrefix?: string
}

export function GiverPicker({
  givers,
  value,
  onChange,
  idPrefix = 'giver',
}: Props) {
  return (
    <SuggestPopup
      label="Giver"
      options={givers}
      value={value}
      onChange={onChange}
      idPrefix={idPrefix}
    />
  )
}
