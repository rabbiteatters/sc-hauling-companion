import { useEffect, useState } from 'react'
import { HAUL_RANKS, parseHaulRank } from '../lib/haulTypes'
import { SuggestPopup } from './SuggestPopup'

interface Props {
  value: string
  onChange: (rank: string) => void
  idPrefix?: string
}

export function RankPicker({ value, onChange, idPrefix = 'rank' }: Props) {
  const [text, setText] = useState(value)

  useEffect(() => {
    setText(value)
  }, [value])

  return (
    <SuggestPopup
      label="Rank"
      options={[...HAUL_RANKS]}
      value={text}
      idPrefix={idPrefix}
      placeholder="Master, Expert…"
      preserveOrder
      onChange={(next) => {
        setText(next)
        const parsed = parseHaulRank(next)
        if (parsed) onChange(parsed)
        else onChange(next)
      }}
    />
  )
}
