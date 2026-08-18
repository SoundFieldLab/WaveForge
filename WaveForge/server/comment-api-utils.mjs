export function getCommentMutationMessage(result) {
  return String(
    result?.error || result?.message || result?.msg || result?.errMsg ||
    result?.data?.error || result?.data?.message || result?.data?.msg || result?.data?.errMsg || ''
  )
}

export function isCommentMutationSuccessful(result) {
  const message = getCommentMutationMessage(result)
  if (/失败|invalid|error|过期|失效/i.test(message)) return false
  if (/成功/.test(message)) return true
  return [result?.result, result?.code, result?.data?.result, result?.data?.code]
    .some(value => value === 0 || value === 100 || value === 200)
}
