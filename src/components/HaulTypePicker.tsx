import { useEffect, useState } from 'react'
import { HAUL_TYPES, parseHaulType } from '../lib/haulTypes'
import type { HaulType } from '../types'
import { SuggestPopup } from './SuggestPopup'

interface Props {
  value: HaulType
  onChange: (haul: HaulType) => void
  idPrefix?: string
}

export function HaulTypePicker({
  value,
  onChange,
  idPrefix = 'haul-type',
}: Props) {
  const [text, setText] = useState<string>(value)

  useEffect(() => {
    setText(value)
  }, [value])

  return (
    <SuggestPopup
      label="Haul type"
      options={[...HAUL_TYPES]}
      value={text}
      idPrefix={idPrefix}
      onChange={(next) => {
        setText(next)
        if ((HAUL_TYPES as string[]).includes(next)) {
          onChange(next as HaulType)
          return
        }
        const parsed = parseHaulType(next)
        if (parsed) onChange(parsed)
      }}
    />
  )
}
