/**
 * What the invite page (Join.svelte) does with the answer of `join` / `signUpJoin`.
 *
 * With MAIL_URL configured, the account service answers `signUpJoin` without a token: the new
 * account must confirm its email first, and the confirmation link finishes the workspace join
 * (upstream hcengineering/platform PR 10861). `join` answers the same way for an account whose
 * email is not confirmed yet. Calling logIn() without a token sends PUT /cookie with no
 * Authorization header, which the account service rejects with 401, so those answers go to the
 * "confirmation sent" page instead (the same guard SignupForm.svelte has, upstream issue 10518).
 */
export function inviteJoinNextStep (result: { token?: string }): 'confirmEmail' | 'openWorkspace' {
  return result.token == null ? 'confirmEmail' : 'openWorkspace'
}
