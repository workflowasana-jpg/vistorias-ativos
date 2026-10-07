# Vistorias de Ativos · DTEL

Sistema web que substitui a planilha "Vistorias Semanais". Os supervisores registram as vistorias, o painel semanal calcula a conformidade por equipe e a Qualidade acompanha tudo.

O site é estático (HTML, CSS e JavaScript, sem etapa de build). O banco de dados e o login ficam no Supabase. A hospedagem é na Vercel, puxando o código do GitHub.

## Estrutura

```
index.html        Telas do sistema
styles.css        Visual (verde e dourado DTEL)
app.js            Lógica e conexão com o Supabase
config.js         URL e chave pública do Supabase (você preenche)
supabase/
  01_schema.sql                  Tabelas, regras e segurança
  02_seed_equipes_tecnicos.sql   14 equipes e 397 técnicos da aba Base
  03 a 06_seed_vistorias_*.sql   10.106 vistorias históricas (2023 a 2026)
  07_liberar_acessos.sql         Modelo para liberar usuários
```

## Passo 1: Supabase

1. Crie uma conta em supabase.com e clique em **New project**. Escolha a região **South America (São Paulo)**.
2. Abra **SQL Editor > New query** e rode os arquivos da pasta `supabase` **na ordem**, um de cada vez: abra o arquivo, copie tudo, cole e clique em **Run**.
   - Se o editor reclamar do tamanho de algum arquivo de vistorias, use **Upload SQL file** ou divida o arquivo ao meio.
3. Crie os usuários em **Authentication > Users > Add user**. Informe e-mail e senha e marque **Auto Confirm User**.
4. Libere cada usuário com o arquivo `07_liberar_acessos.sql`. Cada usuário precisa ter um perfil:
   - **qualidade:** vê todas as equipes e pode corrigir registros;
   - **supervisor:** vê e lança somente a própria equipe.
5. Em **Authentication > Sign In / Providers**, desative **Allow new users to sign up**. Assim só entra quem a Qualidade cadastrar.
6. Em **Project Settings > API**, copie a **Project URL** e a **anon public key** e cole no `config.js`.

## Passo 2: testar no seu computador (opcional)

Na pasta do projeto, rode:

```
npx serve .
```

Depois abra o endereço que aparecer (normalmente http://localhost:3000). Abrir o `index.html` com duplo clique também funciona na maioria dos navegadores.

## Passo 3: GitHub

1. Crie um repositório novo em github.com, de preferência **privado**, por exemplo `vistorias-ativos`.
2. Na pasta do projeto, rode:

```
git init
git add .
git commit -m "Primeira versão do sistema de vistorias"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/vistorias-ativos.git
git push -u origin main
```

Se preferir não usar o terminal, dá para arrastar os arquivos na página do repositório (**Add file > Upload files**).

## Passo 4: Vercel

1. Entre em vercel.com com a conta do GitHub.
2. Clique em **Add New > Project** e importe o repositório.
3. Em **Framework Preset**, escolha **Other**. Deixe build e output em branco.
4. Clique em **Deploy**. O sistema fica disponível em `https://vistorias-ativos.vercel.app` (ou nome parecido).

A partir daí, cada `git push` publica a nova versão automaticamente.

## Nomes no banco

Todos os objetos desta aplicação começam com `vistoria_`, para conviver com outros sistemas no mesmo projeto do Supabase:

| Tabela | Conteúdo |
|---|---|
| `vistoria_equipes` | Equipes (antigas abas de cada gerente) |
| `vistoria_tecnicos` | Cadastro de técnicos (antiga aba Base) |
| `vistoria_perfis` | Quem acessa o sistema e de qual equipe |
| `vistoria_registros` | As vistorias lançadas |

As funções (`vistoria_meu_papel`, `vistoria_minha_equipe`), o gatilho e as regras de segurança seguem o mesmo prefixo. Os usuários de login (Authentication) são compartilhados entre as aplicações do projeto, mas só acessa este sistema quem tiver linha em `vistoria_perfis`.

## Regras que o banco garante sozinho

Essas regras ficam no Supabase, então valem mesmo que alguém tente burlar a tela:

- Supervisor só vê e lança vistorias da própria equipe (regra 1).
- Supervisor, gerente, cidade, base e equipe vêm do cadastro do técnico (regra 2).
- A conformidade é calculada pelos itens críticos: ONU, roteador, cabo de fibra e conectores (regra 3).
- Data futura e técnico inativo são recusados.
- Divergência marcada exige descrição.
- Depois de salva, só a Qualidade edita ou exclui a vistoria (regra 8).
- Só a Qualidade altera o cadastro de técnicos (regra 9).

## Cadastro de técnicos

Por enquanto, a manutenção é feita em **Supabase > Table Editor > vistoria_tecnicos**:

- **Novo técnico:** insira uma linha.
- **Desligamento:** mude `ativo` para `false`. Não apague o técnico, porque o histórico de vistorias dele continua valendo.
- **Troca de supervisor:** edite a coluna `supervisor`. As vistorias antigas continuam com o supervisor da época.

## Observações sobre a importação

- **Registros descartados:** 79 linhas da planilha tinham data inválida ou futura e não foram importadas.
- **Status padronizados:** os status da aba Base foram padronizados para ativo e inativo. Técnicos sem status entraram como ativos.
- **Vistorias sem técnico na Base:** 2.232 vistorias antigas são de técnicos que não estão mais na aba Base. Elas foram mantidas com o nome gravado na própria vistoria.
- **Técnicos sem equipe:** os técnicos do gerente Gabriel Soares não têm equipe correspondente. Crie a equipe e ajuste o `equipe_id` deles quando definir.
