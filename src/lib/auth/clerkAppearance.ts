import type { Appearance } from '@clerk/ui';

export const minimalClerkAppearance: Appearance = {
	options: {
		logoPlacement: 'none',
		socialButtonsVariant: 'blockButton',
		socialButtonsPlacement: 'top',
		animations: false
	},
	variables: {
		fontFamily: "'Helvetica Neue', 'Noto Sans Khmer', 'Noto Sans', sans-serif",
		colorPrimary: '#111111',
		colorBackground: '#ffffff',
		colorForeground: '#111111',
		colorMutedForeground: '#5f5f5f',
		colorInputForeground: '#111111',
		colorInput: '#ffffff',
		colorNeutral: '#e5e5e5',
		colorBorder: '#e5e5e5',
		borderRadius: '0px'
	},
	elements: {
		rootBox: 'w-full',
		cardBox: 'w-full shadow-none',
		card: 'w-full gap-6 border-0 bg-transparent p-0 shadow-none',
		header: 'hidden',
		main: 'gap-6',
		socialButtons: 'gap-3',
		socialButtonsBlockButton:
			'h-11 border border-black/10 bg-white text-[#111111] shadow-none hover:bg-black/[0.02]',
		socialButtonsBlockButtonText: 'text-sm font-medium text-[#111111]',
		providerIcon: 'text-[#111111]',
		dividerRow: 'gap-4',
		dividerLine: 'bg-black/10',
		dividerText: 'text-xs font-medium uppercase tracking-[0.24em] text-[#8a8a8a]',
		formFieldLabel: 'text-sm font-medium text-[#111111]',
		formFieldInput:
			'h-11 border border-black/10 bg-white text-sm text-[#111111] shadow-none placeholder:text-[#9a9a9a] focus:border-black/25 focus:ring-0',
		formFieldInputShowPasswordButton: 'text-[#6f6f6f] hover:text-[#111111]',
		formButtonPrimary:
			'h-11 bg-[#111111] text-sm font-medium text-white shadow-none hover:bg-black disabled:bg-[#b8b8b8]',
		footer: 'pt-2',
		footerAction: 'text-sm text-[#6f6f6f]',
		footerActionLink: 'font-medium text-[#111111] hover:text-black',
		footerPages: 'hidden',
		identityPreviewText: 'text-sm text-[#111111]',
		formResendCodeLink: 'font-medium text-[#111111] hover:text-black'
	}
};
