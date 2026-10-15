import { PrismLight } from 'react-syntax-highlighter';
import { makePrismLightSyntaxHighlighter } from '@assistant-ui/react-syntax-highlighter';
import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown';

import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';

import { coldarkCold, coldarkDark } from 'react-syntax-highlighter/dist/cjs/styles/prism';

// Bundle the registered grammars with the Webview for offline highlighting.
PrismLight.registerLanguage('js', tsx);
PrismLight.registerLanguage('jsx', tsx);
PrismLight.registerLanguage('javascript', tsx);
PrismLight.registerLanguage('ts', tsx);
PrismLight.registerLanguage('tsx', tsx);
PrismLight.registerLanguage('typescript', tsx);
PrismLight.registerLanguage('python', python);
PrismLight.registerLanguage('py', python);

const syntaxHighlighterCustomStyle = {
  // Unset so the markdown Pre's theme surface shows instead of the Prism theme's own background.
  background: undefined,
  margin: 0,
  width: '100%',
  padding: '0.75rem',
};

const LightSyntaxHighlighter = makePrismLightSyntaxHighlighter({
  style: coldarkCold,
  customStyle: syntaxHighlighterCustomStyle,
  className: 'dark:hidden',
});

const DarkSyntaxHighlighter = makePrismLightSyntaxHighlighter({
  style: coldarkDark,
  customStyle: syntaxHighlighterCustomStyle,
  className: 'hidden dark:block',
});

export const SyntaxHighlighter = (props: SyntaxHighlighterProps) => (
  <>
    <LightSyntaxHighlighter {...props} />
    <DarkSyntaxHighlighter {...props} />
  </>
);
