/**
 * The console's form kit: TanStack Form + a zod schema per form + shadcn Field.
 *
 * - `useAppForm({ defaultValues, validationLogic: formValidation, validators: { onDynamic: schema }, onSubmit })`
 *   validates on submit and then live on every change (`revalidateLogic`), so errors appear under the
 *   field the user must fix and disappear as they fix it. No native HTML validation: every `<Form>` is
 *   `noValidate`.
 * - Field components read the field from context, so a form body is a list of `<form.AppField>`s.
 * - `method="post"` and a hydration-gated submit button are kept from the first build: a submit before
 *   hydration must never put the values in the URL (12-phase-4-findings.md, hydration trap).
 */
import { createFormHook, createFormHookContexts, revalidateLogic } from '@tanstack/react-form'
import { useHydrated } from '@tanstack/react-router'
import { type ComponentProps, type ComponentType, type ReactNode, useId } from 'react'

import { Spinner } from '@/components/spinner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from '@/components/ui/combobox'
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldSet, FieldTitle } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

export const { fieldContext, formContext, useFieldContext, useFormContext } = createFormHookContexts()

/** Validation strategy shared by every console form: quiet until the first submit, then live. */
export const formValidation = revalidateLogic()

// --- field building blocks -------------------------------------------------------------------

export function toErrors(errors: unknown[]): Array<{ message: string }> {
  return errors
    .map((error): { message: string } | null => {
      if (typeof error === 'string') return { message: error }
      if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return { message: error.message }
      return null
    })
    .filter((error): error is { message: string } => error !== null)
}

interface FieldChromeProps {
  label: ReactNode
  description?: ReactNode
  className?: string
}

/** Label + control + description + errors for a single-control field. */
function FieldShell({ label, description, className, children }: FieldChromeProps & { children: (props: { id: string; invalid: boolean; describedBy: string | undefined; hydrated: boolean }) => ReactNode }) {
  const field = useFieldContext()
  const id = useId()
  // Before hydration a controlled input would drop what was typed once React takes over; keep it
  // read-only until then (same reason the submit button waits).
  const hydrated = useHydrated()
  const errors = toErrors(field.state.meta.errors)
  const invalid = errors.length > 0
  const descriptionId = description ? `${id}-description` : undefined
  return (
    <Field className={className} data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children({ id, invalid, describedBy: descriptionId, hydrated })}
      {description && <FieldDescription id={descriptionId}>{description}</FieldDescription>}
      <FieldError errors={errors} />
    </Field>
  )
}

type InputExtras = Pick<ComponentProps<'input'>, 'placeholder' | 'autoComplete' | 'autoFocus' | 'maxLength' | 'disabled' | 'inputMode'>

export function TextField({ type = 'text', ...props }: FieldChromeProps & InputExtras & { type?: 'text' | 'email' | 'url' }) {
  const field = useFieldContext<string>()
  const { label, description, className, ...input } = props
  return (
    <FieldShell label={label} description={description} className={className}>
      {({ id, invalid, describedBy, hydrated }) => (
        <Input
          id={id}
          name={field.name}
          type={type}
          readOnly={!hydrated}
          value={field.state.value}
          onBlur={field.handleBlur}
          onChange={(event) => field.handleChange(event.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          {...input}
        />
      )}
    </FieldShell>
  )
}

export function PasswordField(props: FieldChromeProps & InputExtras) {
  const field = useFieldContext<string>()
  const { label, description, className, ...input } = props
  return (
    <FieldShell label={label} description={description} className={className}>
      {({ id, invalid, describedBy, hydrated }) => (
        <Input
          id={id}
          name={field.name}
          type="password"
          readOnly={!hydrated}
          value={field.state.value}
          onBlur={field.handleBlur}
          onChange={(event) => field.handleChange(event.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          {...input}
        />
      )}
    </FieldShell>
  )
}

export function TextareaField(props: FieldChromeProps & Pick<ComponentProps<'textarea'>, 'placeholder' | 'rows' | 'disabled'> & { mono?: boolean }) {
  const field = useFieldContext<string>()
  const { label, description, className, mono, ...textarea } = props
  return (
    <FieldShell label={label} description={description} className={className}>
      {({ id, invalid, describedBy, hydrated }) => (
        <Textarea
          id={id}
          name={field.name}
          readOnly={!hydrated}
          value={field.state.value}
          onBlur={field.handleBlur}
          onChange={(event) => field.handleChange(event.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={cn(mono && 'font-mono text-xs')}
          {...textarea}
        />
      )}
    </FieldShell>
  )
}

/** Whole numbers, or any number with `decimal`. The field holds a number; an empty or partial input is `NaN` until it parses, which the schema reports. */
export function NumberField(props: FieldChromeProps & Pick<ComponentProps<'input'>, 'placeholder' | 'disabled' | 'min' | 'max'> & { decimal?: boolean }) {
  const field = useFieldContext<number>()
  const { label, description, className, decimal, ...input } = props
  return (
    <FieldShell label={label} description={description} className={className}>
      {({ id, invalid, describedBy, hydrated }) => (
        <Input
          id={id}
          name={field.name}
          type="number"
          readOnly={!hydrated}
          step={decimal ? 'any' : 1}
          inputMode={decimal ? 'decimal' : 'numeric'}
          value={Number.isFinite(field.state.value) ? field.state.value : ''}
          onBlur={field.handleBlur}
          onChange={(event) => field.handleChange(event.target.value === '' ? Number.NaN : decimal ? Number.parseFloat(event.target.value) : Number.parseInt(event.target.value, 10))}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          {...input}
        />
      )}
    </FieldShell>
  )
}

/** One boolean as a checkbox with its label beside it. */
export function CheckboxField({ label, description, className, disabled }: FieldChromeProps & { disabled?: boolean }) {
  const field = useFieldContext<boolean>()
  const id = useId()
  const hydrated = useHydrated()
  const errors = toErrors(field.state.meta.errors)
  return (
    <Field orientation="horizontal" className={className} data-invalid={errors.length > 0 || undefined}>
      <Checkbox
        id={id}
        name={field.name}
        checked={field.state.value}
        onCheckedChange={(checked) => field.handleChange(checked)}
        onBlur={field.handleBlur}
        disabled={disabled || !hydrated}
        aria-invalid={errors.length > 0 || undefined}
      />
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {description && <FieldDescription>{description}</FieldDescription>}
        <FieldError errors={errors} />
      </FieldContent>
    </Field>
  )
}

/** One boolean as a switch, label on the left. */
export function SwitchField({ label, description, className, disabled }: FieldChromeProps & { disabled?: boolean }) {
  const field = useFieldContext<boolean>()
  const id = useId()
  const hydrated = useHydrated()
  const errors = toErrors(field.state.meta.errors)
  return (
    <Field orientation="horizontal" className={className} data-invalid={errors.length > 0 || undefined}>
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {description && <FieldDescription>{description}</FieldDescription>}
        <FieldError errors={errors} />
      </FieldContent>
      <Switch id={id} name={field.name} checked={field.state.value} onCheckedChange={(checked) => field.handleChange(checked)} onBlur={field.handleBlur} disabled={disabled || !hydrated} />
    </Field>
  )
}

export interface ChoiceOption<T extends string = string> {
  value: T
  label: string
  description?: string
  disabled?: boolean
}

/** A set of checkboxes bound to a string array. */
export function CheckboxGroupField<T extends string>({
  label,
  description,
  className,
  options,
  mono,
  emptyMessage = 'Nothing to choose from yet.',
}: FieldChromeProps & { options: ReadonlyArray<ChoiceOption<T>>; mono?: boolean; emptyMessage?: ReactNode }) {
  const field = useFieldContext<T[]>()
  const id = useId()
  const hydrated = useHydrated()
  const errors = toErrors(field.state.meta.errors)
  const selected = field.state.value
  return (
    <FieldSet className={className} data-invalid={errors.length > 0 || undefined} aria-describedby={description ? `${id}-description` : undefined}>
      <FieldTitle>{label}</FieldTitle>
      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {options.map((option) => {
            const optionId = `${id}-${option.value}`
            return (
              <Field key={option.value} orientation="horizontal" className="w-auto">
                <Checkbox
                  id={optionId}
                  checked={selected.includes(option.value)}
                  disabled={option.disabled || !hydrated}
                  onCheckedChange={(checked) => field.handleChange(checked ? [...selected, option.value] : selected.filter((value) => value !== option.value))}
                  aria-invalid={errors.length > 0 || undefined}
                />
                <FieldLabel htmlFor={optionId} className={cn('font-normal', mono && 'font-mono text-xs')} title={option.description}>
                  {option.label}
                </FieldLabel>
              </Field>
            )
          })}
        </div>
      )}
      {description && <FieldDescription id={`${id}-description`}>{description}</FieldDescription>}
      <FieldError errors={errors} />
    </FieldSet>
  )
}

/** The combobox itself, without a field: a controlled single choice with type-to-filter. */
export function ComboboxControl<T extends string>({
  id,
  options,
  value,
  onChange,
  onBlur,
  placeholder = 'Choose…',
  emptyMessage = 'No matches.',
  disabled,
  invalid,
  describedBy,
  name,
  className,
  'aria-label': ariaLabel,
}: {
  id?: string
  options: ReadonlyArray<ChoiceOption<T>>
  value: T | ''
  onChange: (value: T | '') => void
  onBlur?: () => void
  placeholder?: string
  emptyMessage?: string
  disabled?: boolean
  invalid?: boolean
  describedBy?: string
  name?: string
  className?: string
  'aria-label'?: string
}) {
  const selected = options.find((option) => option.value === value) ?? null
  return (
    <Combobox<ChoiceOption<T>>
      items={options as ChoiceOption<T>[]}
      value={selected}
      onValueChange={(option) => onChange(option?.value ?? '')}
      itemToStringLabel={(option) => option.label}
      itemToStringValue={(option) => option.value}
      isItemEqualToValue={(a, b) => a.value === b.value}
      disabled={disabled}
      name={name}
    >
      <ComboboxInput id={id} placeholder={placeholder} onBlur={onBlur} aria-invalid={invalid || undefined} aria-describedby={describedBy} aria-label={ariaLabel} className={cn('w-full', className)} />
      <ComboboxContent>
        <ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
        <ComboboxList>
          {(option: ChoiceOption<T>) => (
            <ComboboxItem key={option.value} value={option} disabled={option.disabled}>
              <span className="flex flex-col">
                <span>{option.label}</span>
                {option.description && <span className="text-xs text-muted-foreground">{option.description}</span>}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

/** Single choice with type-to-filter, used wherever a `<select>` would be. Holds the option's value (`''` for none). */
export function ComboboxField<T extends string>({
  label,
  description,
  className,
  options,
  placeholder,
  emptyMessage,
  disabled,
  inputClassName,
}: FieldChromeProps & { options: ReadonlyArray<ChoiceOption<T>>; placeholder?: string; emptyMessage?: string; disabled?: boolean; inputClassName?: string }) {
  const field = useFieldContext<T | ''>()
  return (
    <FieldShell label={label} description={description} className={className}>
      {({ id, invalid, describedBy, hydrated }) => (
        <ComboboxControl
          id={id}
          name={field.name}
          options={options}
          value={field.state.value}
          onChange={field.handleChange}
          onBlur={field.handleBlur}
          placeholder={placeholder}
          emptyMessage={emptyMessage}
          disabled={disabled || !hydrated}
          invalid={invalid}
          describedBy={describedBy}
          className={inputClassName}
        />
      )}
    </FieldShell>
  )
}

// --- form-level pieces -----------------------------------------------------------------------

/** The submit button: disabled until hydration (see the hydration trap), and spinning while submitting. */
export function SubmitButton({ children, pendingLabel, disabled, ...props }: ComponentProps<typeof Button> & { pendingLabel?: ReactNode }) {
  const form = useFormContext()
  const hydrated = useHydrated()
  return (
    <form.Subscribe selector={(state) => state.isSubmitting}>
      {(isSubmitting) => (
        <Button type="submit" disabled={!hydrated || isSubmitting || disabled} {...props}>
          {isSubmitting && <Spinner />}
          {isSubmitting && pendingLabel ? pendingLabel : children}
        </Button>
      )}
    </form.Subscribe>
  )
}


/**
 * Errors that belong to the whole form: the server's refusal, plus schema issues that no mounted
 * field shows (issues on the root, or on a path the form has no field for).
 */
export function FormError({ error }: { error?: Error | string | null }) {
  const form = useFormContext()
  return (
    <form.Subscribe selector={(state) => [state.errors, Object.keys(state.fieldMeta)] as const}>
      {([errors, mountedFields]) => {
        const formLevel = errors
          .flatMap((entry): unknown[] => {
            if (!entry || typeof entry !== 'object' || 'message' in entry) return [entry]
            // A schema validator's result: `{ [fieldPath]: issues[] }`, fielded issues are shown by their fields.
            return Object.entries(entry as Record<string, unknown[]>).flatMap(([path, issues]) => (mountedFields.includes(path) ? [] : issues))
          })
          .filter((issue) => Boolean(issue))
        const formMessages = toErrors(formLevel).map((issue) => issue.message)
        const server = error instanceof Error ? error.message : error
        const messages = [...new Set([...formMessages, server].filter((message): message is string => Boolean(message)))]
        if (messages.length === 0) return null
        return (
          <Alert variant="destructive">
            <AlertDescription>
              {messages.length === 1 ? (
                messages[0]
              ) : (
                <ul className="list-disc pl-4">
                  {messages.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              )}
            </AlertDescription>
          </Alert>
        )
      }}
    </form.Subscribe>
  )
}

export const { useAppForm, withForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: { TextField, PasswordField, TextareaField, NumberField, CheckboxField, SwitchField, CheckboxGroupField, ComboboxField },
  formComponents: { SubmitButton, FormError },
})

/** The `<form>` element every console form uses: no native validation, POST, submit through TanStack Form. */
export function Form({
  form,
  className,
  children,
  ...props
}: Omit<ComponentProps<'form'>, 'onSubmit' | 'noValidate' | 'method'> & {
  form: { handleSubmit: () => Promise<void>; AppForm: ComponentType<{ children?: ReactNode }> }
}) {
  return (
    <form.AppForm>
      <form
        noValidate
        method="post"
        onSubmit={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void form.handleSubmit()
        }}
        className={cn('flex flex-col gap-4', className)}
        {...props}
      >
        {children}
      </form>
    </form.AppForm>
  )
}

/**
 * Runs a mutation from a form's `onSubmit`. A failure stays in `mutation.error` for `<form.FormError>`
 * and is not rethrown, so the form neither crashes nor reports success; `onSuccess` runs only after a
 * successful call.
 */
export async function submitMutation<TInput, TResult>(mutation: { mutateAsync: (input: TInput) => Promise<TResult> }, input: TInput, onSuccess?: (result: TResult) => void | Promise<void>) {
  let result: TResult
  try {
    result = await mutation.mutateAsync(input)
  } catch {
    return
  }
  await onSuccess?.(result)
}
