'use client'

/**
 * The select, over Radix, with the geometry docs/08 §4 gives a select rather than shadcn's.
 *
 * ## Why the direction is not passed in here
 *
 * Radix's Select reads direction from `DirectionProvider` itself — `useDirection()` inside
 * `Select.Root`, which it then puts on **both** the trigger and the portalled listbox as a `dir`
 * attribute. That is the mechanism the acceptance line is about, and passing `dir` down by hand here
 * would prove that this file can pass an attribute rather than that the provider reaches the portal.
 * `apps/web/src/primitives.itest.ts` opens this on `/ar/kitchen-sink` and reads the attribute off the
 * portalled content, which is in `document.body` and therefore outside every wrapper the page renders.
 *
 * `Popover` and `Dialog` carry no direction of their own in Radix, so those two do pass it explicitly.
 *
 * ## Why the trigger is labelled with `aria-labelledby`
 *
 * Every other control in `field.tsx` is wrapped in its `<label>`, which needs no id and cannot be
 * broken by a duplicated one. A Radix select trigger is a `<button role="combobox">`, and a button
 * takes its accessible name from its own content — which here is the *selected value*. Without the
 * association the control announces "60 minutes" and never says what it is 60 minutes of.
 */
import * as SelectPrimitive from '@radix-ui/react-select'
import { useId } from 'react'
import { Icon } from '../icon.tsx'

export interface SelectOption {
  readonly value: string
  readonly label: string
}

export interface SelectProps {
  readonly label: string
  readonly options: readonly SelectOption[]
  readonly defaultValue?: string
  readonly placeholder?: string
  /** Set only when the select is inside a form: it names the value Radix mirrors for submission. */
  readonly name?: string
}

export function Select({ label, options, defaultValue, placeholder, name }: SelectProps) {
  const labelId = useId()
  return (
    <div className="be-control be-select-field">
      <span className="be-control__label" id={labelId}>
        {label}
      </span>
      {/*
        Spread rather than `name={name}`: this repository compiles with `exactOptionalPropertyTypes`,
        and Radix declares `name?: string` without `| undefined`, so passing the absent case explicitly
        is a type error rather than an omission.
      */}
      <SelectPrimitive.Root
        {...(defaultValue === undefined ? {} : { defaultValue })}
        {...(name === undefined ? {} : { name })}
      >
        <SelectPrimitive.Trigger className="be-select" aria-labelledby={labelId}>
          <SelectPrimitive.Value placeholder={placeholder} />
          <SelectPrimitive.Icon className="be-select__chevron">
            <Icon name="chevron" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          {/*
            `position="popper"` rather than Radix's default `item-aligned`: the aligned mode moves the
            list so the selected row sits over the trigger, which on a phone puts a 48px row under the
            thumb that is already pressing. The popper drops the menu below the control, like every
            other menu in the system.
          */}
          <SelectPrimitive.Content
            className="be-overlay be-select__content"
            position="popper"
            sideOffset={8}
          >
            <SelectPrimitive.Viewport className="be-select__viewport">
              {options.map((option) => (
                <SelectPrimitive.Item
                  className="be-select__item"
                  key={option.value}
                  value={option.value}
                >
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator>
                    <Icon name="check" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </div>
  )
}
