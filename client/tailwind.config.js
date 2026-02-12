export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        background: '#000000',
        accent: {
          400: '#facc15',
          500: '#eab308'
        },
        border: 'rgba(255,255,255,0.2)'
      },
      fontFamily: {
        serif: ['\"Instrument Serif\"', 'serif']
      }
    }
  },
  plugins: []
}

